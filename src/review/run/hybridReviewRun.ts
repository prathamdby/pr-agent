import { resolveAgentRunnerProvider } from "../../agent/providers/index.js";
import type { AgentRunnerToolExecutor } from "../../agent/providers/interface.js";
import { assistantFromText } from "../../agentRun/sessionHelpers.js";
import { logInfo, logWarn } from "../../evlog.js";
import type { ListPullRequestFilesResult } from "../../github/listPullRequestFiles.js";
import {
  REVIEW_CANCELLATION_POLL_MS,
  REVIEW_PROMPT_CONTRACT_VERSION,
  TOKEN_FRESHNESS_BUFFER_MS,
} from "../../settings/index.js";
import type { ReviewMode } from "../reviewSchema.js";
import type { ReviewPayload } from "../reviewSchema.js";
import type { SubmitReviewState } from "../publish/submitReviewTool.js";
import { redactReviewPayloadSecrets } from "../findings/reviewPublicOutput.js";
import {
  payloadCheckpointMatches,
  type ReviewPayloadCheckpointStore,
} from "./reviewCriticCheckpoint.js";
import { runCriticWave, selectCriticInvestigationTools } from "./reviewCritics.js";
import { buildReviewEvidenceSnapshot } from "./reviewEvidence.js";
import { publishReviewRunFailureNotice } from "./reviewRunFallback.js";
import {
  initReviewRunMetrics,
  logReviewRunCompleted,
  recordReviewMetric,
  recordReviewPhaseSpan,
  setReviewRunMetricFields,
} from "./reviewRunMetrics.js";
import { buildReviewRunSetup, shouldContinueReviewRun } from "./reviewRunSetup.js";
import type { ReviewRunParams, ReviewRunResult } from "./reviewRunTypes.js";
import { createReviewSessionRegistry } from "./reviewSessionRegistry.js";
import { buildHybridSynthesisContext, runSubmissionOnlySynthesis } from "./reviewSynthesis.js";
import {
  applyValidationVerdicts,
  collectHighRiskCandidates,
  runBatchValidation,
} from "./reviewValidation.js";

function tokenTtlMsOrDefault(value: number | undefined, mode: ReviewMode): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  logWarn("review_token_ttl_defaulted", { mode });
  return TOKEN_FRESHNESS_BUFFER_MS;
}

type PayloadCheckpointScope = {
  readonly headSha: string;
  readonly evidenceHash: string;
  readonly promptContractVersion: number;
};

/**
 * Persist the payload once it has passed validation so durable retries can
 * republish deterministically without another synthesis turn (KTD8).
 */
function wrapSubmitWithPayloadCheckpoint(params: {
  submitExecutor: AgentRunnerToolExecutor;
  submitState: SubmitReviewState;
  payloadStore: ReviewPayloadCheckpointStore;
  workItemId: string;
  scope: PayloadCheckpointScope;
}): AgentRunnerToolExecutor {
  const saveOnce = async (payload: Record<string, unknown>) => {
    try {
      const redacted = redactReviewPayloadSecrets(payload as ReviewPayload) as Record<
        string,
        unknown
      >;
      await params.payloadStore.saveOnce({
        workItemId: params.workItemId,
        headSha: params.scope.headSha,
        evidenceHash: params.scope.evidenceHash,
        promptContractVersion: params.scope.promptContractVersion,
        payload: redacted,
      });
    } catch (error) {
      logWarn("review_payload_checkpoint_save_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
  return async (args) => {
    try {
      const result = await params.submitExecutor(args);
      await saveOnce(args);
      return result;
    } catch (error) {
      const validated =
        !params.submitState.lastValidationError && !params.submitState.publishSuperseded;
      if (validated) await saveOnce(args);
      throw error;
    }
  };
}

export async function runHybridPrReview(
  params: ReviewRunParams & { readonly prFiles: ListPullRequestFilesResult },
): Promise<ReviewRunResult> {
  if (!Number.isFinite(params.tokenExpiresAtTs)) {
    throw new Error("tokenExpiresAtTs must be a finite timestamp in milliseconds");
  }
  const { cfg, owner, repo, prNumber, headSha } = params;
  const reviewMode = params.mode ?? "review";
  const tokenTtlMs = tokenTtlMsOrDefault(params.tokenTtlMs, reviewMode);
  const providerName = cfg.agentProvider;
  initReviewRunMetrics({ provider: providerName, model: cfg.piModel, mode: reviewMode });

  const setup = buildReviewRunSetup({ ...params, tokenTtlMs, reviewMode });
  const runner = resolveAgentRunnerProvider(cfg);
  const registry = createReviewSessionRegistry();
  const submitTool = setup.piTools.find((tool) => tool.name === "submitReview");
  const submitExecutor = setup.executors.submitReview;
  if (!submitTool || !submitExecutor) {
    throw new Error("Hybrid review requires submitReview");
  }
  const investigationTools = selectCriticInvestigationTools({
    piTools: setup.piTools,
    executors: setup.executors,
  });

  const abortController = new AbortController();
  let lastText = "";
  let abortCheck: Promise<boolean> | undefined;
  let cancellationWatcher: Promise<void> | undefined;
  let cancelCancellationDelay: (() => void) | undefined;

  const finish = (): ReviewRunResult => {
    setReviewRunMetricFields({
      published: setup.submitState.published,
      publishAttempts: setup.submitState.publishCallCount,
    });
    logReviewRunCompleted({ pipeline_mode: "hybrid" });
    return {
      lastAssistant: assistantFromText(cfg, lastText, providerName),
      published: setup.submitState.published,
      publishAttempts: setup.submitState.publishCallCount,
      publishSuperseded: setup.submitState.publishSuperseded,
    };
  };

  const abortIfRequested = async (): Promise<boolean> => {
    if (abortController.signal.aborted) return true;
    if (!params.shouldAbortPublish) return false;
    abortCheck ??= (async () => {
      try {
        return (await params.shouldAbortPublish?.()) ?? false;
      } catch (error) {
        logWarn("review_abort_check_failed", {
          mode: reviewMode,
          owner,
          repo,
          pr: prNumber,
          message: error instanceof Error ? error.message : String(error),
        });
        return true;
      }
    })().finally(() => {
      abortCheck = undefined;
    });
    if (!(await abortCheck)) return false;
    setup.submitState.publishSuperseded = true;
    abortController.abort();
    await registry.cancelAll();
    return true;
  };

  const waitForCancellationPoll = (): Promise<void> =>
    new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const finishDelay = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        abortController.signal.removeEventListener("abort", finishDelay);
        cancelCancellationDelay = undefined;
        resolve();
      };
      timer = setTimeout(finishDelay, REVIEW_CANCELLATION_POLL_MS);
      abortController.signal.addEventListener("abort", finishDelay, { once: true });
      cancelCancellationDelay = finishDelay;
    });

  const startCancellationWatcher = (): void => {
    if (!params.shouldAbortPublish) return;
    cancellationWatcher = (async () => {
      while (!abortController.signal.aborted) {
        await waitForCancellationPoll();
        if (abortController.signal.aborted) return;
        if (await abortIfRequested()) return;
      }
    })();
  };

  try {
    if (await abortIfRequested()) return finish();
    startCancellationWatcher();

    const evidence = await recordReviewPhaseSpan("evidence", () =>
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
    const scope: PayloadCheckpointScope = {
      headSha,
      evidenceHash: evidence.evidenceHash,
      promptContractVersion: REVIEW_PROMPT_CONTRACT_VERSION,
    };

    if (params.hybrid) {
      const checkpoint = await params.hybrid.payloadStore.load(params.hybrid.workItemId);
      if (checkpoint && payloadCheckpointMatches(checkpoint, scope)) {
        logInfo("review_payload_checkpoint_reused", {
          pipeline_mode: "hybrid",
          owner,
          repo,
          pr: prNumber,
          work_item_id: params.hybrid.workItemId,
        });
        await recordReviewPhaseSpan("publication", () => submitExecutor(checkpoint.payload));
        return finish();
      }
    }

    const wave = await recordReviewPhaseSpan("critics", () =>
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
        signal: abortController.signal,
        registry,
        ...(params.hybrid
          ? {
              checkpoints: {
                store: params.hybrid.criticStore,
                workItemId: params.hybrid.workItemId,
              },
            }
          : {}),
      }),
    );
    if (await abortIfRequested()) return finish();
    if (wave.requiredFailed.length > 0) {
      logWarn("required_review_coverage_failed", {
        pipeline_mode: "hybrid",
        failed_critic_ids: wave.failed,
        failed_required_critic_ids: wave.requiredFailed,
        session_roles: wave.requiredFailed.map((critic) => `reviewer:${critic}`),
      });
      throw new Error("Required review coverage did not complete");
    }

    let reports = wave.reports;
    let unvalidatedHighRisk = 0;
    const allCandidates = collectHighRiskCandidates(wave.reports);
    const maxCandidates = Math.max(0, cfg.reviewValidationMaxCandidates);
    const candidates = allCandidates.slice(0, maxCandidates);
    const truncatedCandidates = allCandidates.length - candidates.length;
    if (candidates.length > 0) {
      const validation = await recordReviewPhaseSpan("batch_validation", () =>
        runBatchValidation({
          cfg,
          runner,
          cwd: params.cwd,
          candidates,
          investigationTools,
          refreshBeforeTool: setup.refreshBeforeTool,
          signal: abortController.signal,
          registry,
        }),
      );
      if (await abortIfRequested()) return finish();
      const applied = applyValidationVerdicts(wave.reports, candidates, validation.verdictById);
      reports = applied.reports;
      unvalidatedHighRisk = applied.unvalidatedCount + truncatedCandidates;
    } else if (truncatedCandidates > 0) {
      unvalidatedHighRisk = truncatedCandidates;
    }

    const synthesisSubmitExecutor = params.hybrid
      ? wrapSubmitWithPayloadCheckpoint({
          submitExecutor,
          submitState: setup.submitState,
          payloadStore: params.hybrid.payloadStore,
          workItemId: params.hybrid.workItemId,
          scope,
        })
      : submitExecutor;
    recordReviewMetric({ kind: "phase_enter", phase: "investigation" });
    lastText = await recordReviewPhaseSpan("synthesis", () =>
      runSubmissionOnlySynthesis({
        cfg,
        runner,
        cwd: params.cwd,
        userContent: setup.userContent,
        synthesisContext: buildHybridSynthesisContext({
          reports,
          failedCriticIds: wave.failed,
          unvalidatedHighRisk,
        }),
        submitTool,
        submitExecutor: synthesisSubmitExecutor,
        submitState: setup.submitState,
        refreshBeforeTool: setup.refreshBeforeTool,
        signal: abortController.signal,
        registry,
      }),
    );

    if (!setup.submitState.published && shouldContinueReviewRun(setup)) {
      const willRescheduleStaleHead =
        params.publishAbortState?.staleHead === true && !params.staleHeadRescheduled;
      logWarn("review_publish_exhausted", {
        mode: reviewMode,
        pipeline_mode: "hybrid",
        attempts: setup.submitState.publishCallCount,
        maxAttempts: cfg.maxReviewPublishCalls,
        owner,
        repo,
        pr: prNumber,
        willRescheduleStaleHead,
      });
      if (params.hybrid && !willRescheduleStaleHead) {
        const checkpoint = await params.hybrid.payloadStore.load(params.hybrid.workItemId);
        if (checkpoint && payloadCheckpointMatches(checkpoint, scope)) {
          // A validated payload exists; fail the attempt so the durable retry
          // republishes it deterministically instead of posting a failure notice.
          throw new Error("Review payload captured but publication failed");
        }
      }
      if (!willRescheduleStaleHead && shouldContinueReviewRun(setup)) {
        recordReviewMetric({ kind: "phase_enter", phase: "plaintext_fallback" });
        await publishReviewRunFailureNotice({
          cfg,
          setup,
          owner,
          repo,
          prNumber,
          reviewMode,
          publishAttempts: setup.submitState.publishCallCount,
        });
      }
    }
    return finish();
  } finally {
    abortController.abort();
    cancelCancellationDelay?.();
    await cancellationWatcher;
    await registry.cancelAll();
  }
}
