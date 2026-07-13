import { createHash } from "node:crypto";
import type {
  AgentRunnerProvider,
  AgentRunnerToolExecutor,
} from "../../agent/providers/interface.js";
import type { Config } from "../../config.js";
import { logInfo, logWarn } from "../../evlog.js";
import type { ReviewPayload } from "../reviewSchema.js";
import { createInMemoryReviewCheckpointStores } from "../run/reviewCriticCheckpoint.js";
import { runCriticWave, selectCriticInvestigationTools } from "../run/reviewCritics.js";
import { buildReviewEvidenceSnapshot, type ReviewEvidenceSnapshot } from "../run/reviewEvidence.js";
import { recordReviewPhaseSpan } from "../run/reviewRunMetrics.js";
import { buildReviewRunSetup } from "../run/reviewRunSetup.js";
import { createReviewSessionRegistry } from "../run/reviewSessionRegistry.js";
import { buildHybridSynthesisContext, runSubmissionOnlySynthesis } from "../run/reviewSynthesis.js";
import {
  applyValidationVerdicts,
  collectHighRiskCandidates,
  runBatchValidation,
} from "../run/reviewValidation.js";
import { normalizeFinding, type NormalizedFinding } from "./reviewComparison.js";

export type ShadowResult = {
  readonly findings: readonly NormalizedFinding[];
  readonly payload: ReviewPayload | null;
  readonly durationMs: number;
  readonly degraded: boolean;
};

/**
 * Determine whether a Review work item should be sampled for shadow evaluation.
 * Uses a deterministic hash of the work item identity so the same PR head is
 * consistently sampled or skipped within one rollout window.
 */
export function shouldSampleShadow(params: {
  readonly sampleRate: number;
  readonly workItemId: string;
  readonly headSha: string;
}): boolean {
  if (params.sampleRate <= 0) return false;
  if (params.sampleRate >= 1) return true;
  const hash = createHash("sha256").update(`${params.workItemId}:${params.headSha}`).digest();
  const fraction = hash.readUInt32BE(0) / 0xffffffff;
  return fraction < params.sampleRate;
}

/**
 * Run the hybrid pipeline in structurally non-publishing shadow mode (KTD10).
 * The session receives a payload-capturing submitReview that records findings
 * without any GitHub mutation. No publication executor, token, or publish
 * record is available.
 */
export async function runShadowReview(params: {
  readonly cfg: Config;
  readonly runner: AgentRunnerProvider;
  readonly cwd?: string;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly userSupplement?: string;
  readonly trustedContext?: string;
  readonly workspace: Parameters<typeof buildReviewEvidenceSnapshot>[0]["workspace"];
  readonly prFiles: Parameters<typeof buildReviewEvidenceSnapshot>[0]["prFiles"];
  readonly signal?: AbortSignal;
}): Promise<ShadowResult> {
  const startedAt = Date.now();
  const { cfg, runner, owner, repo, prNumber, headSha } = params;
  const registry = createReviewSessionRegistry();
  const stores = createInMemoryReviewCheckpointStores();

  const setup = buildReviewRunSetup({
    cfg,
    token: "shadow-no-token",
    tokenExpiresAtTs: Number.MAX_SAFE_INTEGER,
    tokenTtlMs: 60_000,
    owner,
    repo,
    prNumber,
    headSha,
    reviewMode: "review",
    userSupplement: params.userSupplement,
    trustedContext: params.trustedContext,
    workspace: params.workspace,
  });

  const submitTool = setup.piTools.find((tool) => tool.name === "submitReview");
  if (!submitTool) throw new Error("Shadow review requires submitReview tool shape");

  const captureRef = { payload: null as ReviewPayload | null };
  const shadowSubmitExecutor: AgentRunnerToolExecutor = async (args) => {
    const payload = args as ReviewPayload;
    captureRef.payload = payload;
    return {
      ok: true,
      shadowCaptured: true,
      findingsCount: (payload as { findings?: unknown[] }).findings?.length ?? 0,
    };
  };

  const investigationTools = selectCriticInvestigationTools({
    piTools: setup.piTools,
    executors: setup.executors,
  });

  try {
    const evidence: ReviewEvidenceSnapshot = await recordReviewPhaseSpan("shadow_evidence", () =>
      buildReviewEvidenceSnapshot({
        owner,
        repo,
        prNumber,
        headSha,
        prFiles: params.prFiles,
        workspace: params.workspace,
        policyContext: params.trustedContext ?? "",
      }),
    );

    const wave = await recordReviewPhaseSpan("shadow_critics", () =>
      runCriticWave({
        cfg,
        runner,
        cwd: params.cwd,
        owner,
        repo,
        prNumber,
        headSha,
        userSupplement: params.userSupplement,
        evidence,
        investigationTools,
        refreshBeforeTool: setup.refreshBeforeTool,
        signal: params.signal,
        registry,
        checkpoints: { store: stores.criticStore, workItemId: "shadow" },
      }),
    );

    if (wave.requiredFailed.length > 0) {
      logWarn("shadow_required_coverage_failed", {
        failedCriticIds: wave.requiredFailed,
      });
      return {
        findings: [],
        payload: null,
        durationMs: Date.now() - startedAt,
        degraded: true,
      };
    }

    let reports = wave.reports;
    const candidates = collectHighRiskCandidates(wave.reports);
    if (candidates.length > 0) {
      const validation = await recordReviewPhaseSpan("shadow_validation", () =>
        runBatchValidation({
          cfg,
          runner,
          cwd: params.cwd,
          candidates,
          investigationTools,
          refreshBeforeTool: setup.refreshBeforeTool,
          signal: params.signal,
          registry,
        }),
      );
      const applied = applyValidationVerdicts(wave.reports, candidates, validation.verdictById);
      reports = applied.reports;
    }

    await recordReviewPhaseSpan("shadow_synthesis", () =>
      runSubmissionOnlySynthesis({
        cfg,
        runner,
        cwd: params.cwd,
        userContent: setup.userContent,
        synthesisContext: buildHybridSynthesisContext({
          reports,
          failedCriticIds: wave.failed,
        }),
        submitTool,
        submitExecutor: shadowSubmitExecutor,
        submitState: setup.submitState,
        refreshBeforeTool: setup.refreshBeforeTool,
        signal: params.signal,
        registry,
      }),
    );

    const findings: NormalizedFinding[] = (captureRef.payload?.findings ?? []).map(
      normalizeFinding,
    );
    logInfo("shadow_review_completed", {
      owner,
      repo,
      pr: prNumber,
      headSha,
      findingsCount: findings.length,
      durationMs: Date.now() - startedAt,
      degraded: wave.degraded,
    });

    return {
      findings,
      payload: captureRef.payload,
      durationMs: Date.now() - startedAt,
      degraded: wave.degraded,
    };
  } catch (error) {
    logWarn("shadow_review_failed", {
      owner,
      repo,
      pr: prNumber,
      headSha,
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      findings: [],
      payload: null,
      durationMs: Date.now() - startedAt,
      degraded: true,
    };
  } finally {
    await registry.cancelAll();
  }
}
