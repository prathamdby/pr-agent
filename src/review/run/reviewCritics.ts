import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { z } from "zod";
import type {
  AgentRunnerProvider,
  AgentRunnerToolExecutor,
} from "../../agent/providers/interface.js";
import type { Config } from "../../config.js";
import { logInfo, logWarn } from "../../evlog.js";
import { REVIEW_PROMPT_CONTRACT_VERSION } from "../../settings/index.js";
import {
  buildCriticSystemPrompt,
  buildCriticUserContent,
  CRITIC_IDS,
  REQUIRED_CRITIC_IDS,
  type CriticId,
} from "../prompts/criticPrompt.js";
import { reviewerReportSchema } from "./reviewEnsemble.js";
import type { ReviewEvidenceSnapshot } from "./reviewEvidence.js";
import { formatReviewEvidenceBlock } from "./reviewEvidence.js";
import type {
  ReviewCriticCheckpointScope,
  ReviewCriticCheckpointStore,
} from "./reviewCriticCheckpoint.js";
import { recordReviewMetric } from "./reviewRunMetrics.js";
import { sendReviewAgentTurn } from "./reviewRunAgentSend.js";
import type { ReviewSessionRegistry } from "./reviewSessionRegistry.js";
import { createReviewToolCallRecorder } from "./reviewToolCallRecorder.js";
import type { ReviewSessionRole } from "./reviewSessionRole.js";

export { CRITIC_IDS, REQUIRED_CRITIC_IDS };
export type { CriticId };

/** Investigation tools critics may use; everything else is absent by construction (KTD4). */
export const CRITIC_INVESTIGATION_TOOL_NAMES = [
  "readWorkspaceFile",
  "searchWorkspace",
  "getWorkspaceDiff",
] as const;

export type CriticReport = z.infer<typeof reviewerReportSchema> & {
  readonly critic: CriticId;
};

/** Total attempts allowed per critic per work item: one run plus one isolated retry (R18). */
const MAX_CRITIC_ATTEMPTS = 2;

function criticSessionRole(critic: CriticId): ReviewSessionRole {
  return `reviewer:${critic}`;
}

export function buildCriticCheckpointScope(params: {
  workItemId: string;
  headSha: string;
  evidenceHash: string;
}): ReviewCriticCheckpointScope {
  return {
    workItemId: params.workItemId,
    headSha: params.headSha,
    evidenceHash: params.evidenceHash,
    promptContractVersion: REVIEW_PROMPT_CONTRACT_VERSION,
  };
}

/** Restrict a full Review tool bundle to the bounded critic investigation surface. */
export function selectCriticInvestigationTools(bundle: {
  readonly piTools: readonly PiTool[];
  readonly executors: Record<string, AgentRunnerToolExecutor>;
}): { piTools: PiTool[]; executors: Record<string, AgentRunnerToolExecutor> } {
  const allowed = new Set<string>(CRITIC_INVESTIGATION_TOOL_NAMES);
  return {
    piTools: bundle.piTools.filter((tool) => allowed.has(tool.name)),
    executors: Object.fromEntries(
      Object.entries(bundle.executors).filter(([name]) => allowed.has(name)),
    ),
  };
}

/**
 * Enforce the successful-investigation-call budget at the server boundary. Once
 * exhausted, calls return a deterministic budget result so the critic submits
 * from the evidence it already holds.
 */
export function withInvestigationCallBudget(
  executors: Record<string, AgentRunnerToolExecutor>,
  maxSuccessfulCalls: number,
): Record<string, AgentRunnerToolExecutor> {
  let successfulCalls = 0;
  return Object.fromEntries(
    Object.entries(executors).map(([name, executor]) => [
      name,
      async (args: Record<string, unknown>) => {
        if (successfulCalls >= maxSuccessfulCalls) {
          return {
            budgetExhausted: true,
            message:
              "Investigation call budget exhausted. Submit your report from the shared evidence and results you already have.",
          };
        }
        const result = await executor(args);
        successfulCalls += 1;
        return result;
      },
    ]),
  );
}

function buildSubmitCriticReportTool(
  onReport: (report: z.infer<typeof reviewerReportSchema>) => void,
): { tool: PiTool; executor: AgentRunnerToolExecutor } {
  return {
    tool: {
      name: "submitCriticReport",
      description:
        "Submit your complete critic report exactly once. This is internal and does not publish to GitHub.",
      parameters: z.toJSONSchema(reviewerReportSchema, {
        unrepresentable: "any",
      }) as PiTool["parameters"],
    },
    executor: async (args) => {
      onReport(reviewerReportSchema.parse(args));
      return { ok: true };
    },
  };
}

export type CriticWaveResult = {
  readonly reports: CriticReport[];
  readonly failed: CriticId[];
  readonly requiredFailed: CriticId[];
  /** Change-safety coverage is missing after its isolated retry (R17). */
  readonly degraded: boolean;
  readonly reusedCriticIds: CriticId[];
};

export type RunCriticWaveParams = {
  readonly cfg: Config;
  readonly runner: AgentRunnerProvider;
  readonly cwd?: string;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly userSupplement?: string;
  readonly evidence: ReviewEvidenceSnapshot;
  readonly investigationTools: {
    readonly piTools: readonly PiTool[];
    readonly executors: Record<string, AgentRunnerToolExecutor>;
  };
  readonly refreshBeforeTool?: (toolName: string) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly registry: ReviewSessionRegistry;
  readonly checkpoints?: {
    readonly store: ReviewCriticCheckpointStore;
    readonly workItemId: string;
  };
};

async function runCriticSession(
  params: RunCriticWaveParams,
  critic: CriticId,
  userContent: string,
): Promise<z.infer<typeof reviewerReportSchema>> {
  let submitted: z.infer<typeof reviewerReportSchema> | undefined;
  const submit = buildSubmitCriticReportTool((report) => {
    if (submitted) throw new Error("Critic report already submitted");
    submitted = report;
  });
  const sessionRole = criticSessionRole(critic);
  const boundedExecutors = withInvestigationCallBudget(
    { ...params.investigationTools.executors },
    params.cfg.reviewCriticMaxInvestigationCalls,
  );
  const session = await params.runner.createSession({
    cfg: params.cfg,
    cwd: params.cwd,
    signal: params.signal,
    systemPrompt: buildCriticSystemPrompt(critic),
    tools: [...params.investigationTools.piTools, submit.tool],
    executors: { ...boundedExecutors, submitCriticReport: submit.executor },
    refreshBeforeTool: params.refreshBeforeTool,
    onToolCallMetric: createReviewToolCallRecorder(sessionRole),
  });
  const unregister = params.registry.register(session);
  try {
    await sendReviewAgentTurn(
      session,
      userContent,
      { maxToolRounds: params.cfg.maxToolRoundsCritic, signal: params.signal },
      sessionRole,
    );
    if (!submitted) throw new Error(`${critic} critic did not submit a report`);
    return submitted;
  } finally {
    unregister();
    await session.dispose();
  }
}

async function runCriticWithRetry(
  params: RunCriticWaveParams,
  critic: CriticId,
  userContent: string,
  scope: ReviewCriticCheckpointScope | undefined,
): Promise<z.infer<typeof reviewerReportSchema> | null> {
  const store = params.checkpoints?.store;
  const key = scope ? { ...scope, criticId: critic } : undefined;
  let localAttempts = 0;
  while (!params.signal?.aborted) {
    let attemptCount = localAttempts + 1;
    if (store && key) {
      const claim = await store.claimAttempt(key);
      if (!claim.claimed) {
        const stored = (await store.loadCheckpoints(key)).get(critic);
        const parsed = reviewerReportSchema.safeParse(stored?.report ?? {});
        if (parsed.success) return parsed.data;
        throw new Error(`${critic} critic checkpoint is completed but unreadable`);
      }
      attemptCount = claim.attemptCount;
    }
    if (attemptCount > MAX_CRITIC_ATTEMPTS) {
      if (store && key) await store.markExhausted(key);
      return null;
    }
    localAttempts = attemptCount;
    try {
      const report = await runCriticSession(params, critic, userContent);
      if (store && key) {
        await store.saveCompletedReport(key, report as unknown as Record<string, unknown>);
      }
      return report;
    } catch (error) {
      if (params.signal?.aborted) return null;
      logWarn("review_critic_attempt_failed", {
        critic,
        session_role: criticSessionRole(critic),
        attempt: attemptCount,
        message: error instanceof Error ? error.message : String(error),
      });
      if (attemptCount >= MAX_CRITIC_ATTEMPTS) {
        if (store && key) await store.markExhausted(key);
        return null;
      }
    }
  }
  return null;
}

/**
 * Run the four critics in one parallel wave (R1), reusing exact-match
 * checkpoints and retrying each failed critic at most once in isolation.
 */
export async function runCriticWave(params: RunCriticWaveParams): Promise<CriticWaveResult> {
  const startedAt = Date.now();
  const scope = params.checkpoints
    ? buildCriticCheckpointScope({
        workItemId: params.checkpoints.workItemId,
        headSha: params.headSha,
        evidenceHash: params.evidence.evidenceHash,
      })
    : undefined;

  const reportByCritic = new Map<CriticId, z.infer<typeof reviewerReportSchema>>();
  const reused: CriticId[] = [];
  if (params.checkpoints && scope) {
    const existing = await params.checkpoints.store.loadCheckpoints(scope);
    for (const critic of CRITIC_IDS) {
      const checkpoint = existing.get(critic);
      if (checkpoint?.status !== "completed") continue;
      const parsed = reviewerReportSchema.safeParse(checkpoint.report ?? {});
      if (!parsed.success) continue;
      reportByCritic.set(critic, parsed.data);
      reused.push(critic);
    }
  }

  const missing = CRITIC_IDS.filter((critic) => !reportByCritic.has(critic));
  const userContent = buildCriticUserContent({
    owner: params.owner,
    repo: params.repo,
    prNumber: params.prNumber,
    headSha: params.headSha,
    userSupplement: params.userSupplement,
    evidenceBlock: formatReviewEvidenceBlock(params.evidence),
  });

  const failed: CriticId[] = [];
  await Promise.all(
    missing.map(async (critic) => {
      const report = await runCriticWithRetry(params, critic, userContent, scope);
      if (params.signal?.aborted) return;
      if (report) {
        reportByCritic.set(critic, report);
      } else {
        failed.push(critic);
      }
    }),
  );

  const reports: CriticReport[] = CRITIC_IDS.flatMap((critic) => {
    const report = reportByCritic.get(critic);
    return report ? [{ critic, ...report }] : [];
  });
  failed.sort((a, b) => CRITIC_IDS.indexOf(a) - CRITIC_IDS.indexOf(b));
  const requiredFailed = failed.filter((critic) =>
    (REQUIRED_CRITIC_IDS as readonly string[]).includes(critic),
  );
  const degraded = failed.length > 0 && requiredFailed.length === 0;
  const candidateFindings = reports.reduce((total, report) => total + report.findings.length, 0);
  const durationMs = Date.now() - startedAt;
  recordReviewMetric({
    kind: "ensemble_completed",
    completedReviewerIds: reports.map((report) => report.critic),
    failedReviewerIds: failed,
    selectedReviewerIds: [...CRITIC_IDS],
    omittedReviewerIds: [],
    candidateFindings,
    durationMs,
    degraded,
  });
  logInfo("review_critic_wave_completed", {
    pipeline_mode: "hybrid",
    completed: reports.length,
    reused_critic_ids: reused,
    failed_critic_ids: failed,
    required_failed_critic_ids: requiredFailed,
    candidate_findings: candidateFindings,
    duration_ms: durationMs,
    degraded,
  });
  return { reports, failed, requiredFailed, degraded, reusedCriticIds: reused };
}
