import type { Config } from "../../config.js";
import { AppError } from "../../errors/appError.js";
import { logWarn } from "../../evlog.js";
import { assistantFromText } from "../../agentRun/sessionHelpers.js";
import {
  resolveAgentRunnerProvider,
  type AgentRunnerProvider,
} from "../../agent/providers/index.js";
import { TOKEN_FRESHNESS_BUFFER_MS } from "../../settings/index.js";
import type { ReviewRunParams, ReviewRunResult } from "../run/reviewRunTypes.js";
import {
  initReviewRunMetrics,
  logReviewRunCompleted,
  setReviewRunMetricFields,
} from "../run/reviewRunMetrics.js";
import { initialSpecialistTickState } from "../run/progressComment.js";
import { publishReviewRunFailureNotice } from "../run/reviewRunFallback.js";
import { buildReviewWorkspaceTools } from "../run/reviewWorkspaceTools.js";
import { createPublishAbortGateCell } from "../publish/publishAbortGate.js";
import {
  createThreadPublishRunState,
  type ThreadPublishRunState,
} from "../publish/threadPublishRunState.js";
import { buildSpecialistBriefTool } from "./briefTool.js";
import { computeRunDeadlineAtMs } from "./deadlineBudget.js";
import { createOrchestratorSessionController } from "./orchestratorSessionController.js";
import { runJudgmentPhase } from "./orchestratorJudgment.js";
import { runReconPhase } from "./orchestratorRecon.js";
import {
  sendOrchestratorTurnOnceWithRetry,
  type OrchestratorSendResult,
} from "./orchestratorSend.js";
import { runSummaryPhase } from "./orchestratorSummary.js";
import { buildOrchestratorSystemPrompt } from "./prompts/orchestratorPrompts.js";
import { buildPublishSummaryTool, createSummaryCaptureState } from "./publishSummaryTool.js";
import { buildPublishThreadTool } from "./publishThreadTool.js";
import { createRunAbortScope } from "./runAbortScope.js";
import type { SpecialistOutcomeSummary } from "./specialistReport.js";
import { tickProgressComment } from "./stubTick.js";

function tokenTtlMsOrDefault(value: number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  logWarn("review_token_ttl_defaulted", { mode: "review" });
  return TOKEN_FRESHNESS_BUFFER_MS;
}

/**
 * Orchestrated review: one recon/judgment/synthesis session plus four parallel specialists.
 */
export async function runOrchestratedPrReview(
  params: ReviewRunParams,
  options?: { readonly provider?: AgentRunnerProvider },
): Promise<ReviewRunResult> {
  if (!Number.isFinite(params.tokenExpiresAtTs)) {
    throw new AppError({
      code: "review.invalid_token_expiry_ts",
      message: "tokenExpiresAtTs must be a finite timestamp in milliseconds",
    });
  }

  const { cfg, owner, repo, prNumber } = params;
  const now = params.now ?? Date.now;
  const sleep =
    params.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const tokenTtlMs = tokenTtlMsOrDefault(params.tokenTtlMs);
  const provider = options?.provider ?? resolveAgentRunnerProvider(cfg);
  const startedAtMs = now();
  const deadlineAtMs =
    params.deadlineAtMs ??
    computeRunDeadlineAtMs({
      nowMs: startedAtMs,
      queueExpireInSeconds: cfg.queueExpireInSeconds,
    });

  initReviewRunMetrics({
    provider: cfg.agentProvider,
    model: cfg.piModel,
    mode: "review",
  });

  if (params.initialPublishState?.published === true) {
    return finish({
      cfg,
      lastText: "",
      published: true,
      publishAttempts: 0,
      publishSuperseded: false,
      runState: createThreadPublishRunState({
        postedInlineCount: params.initialPublishState.postedInlineCount ?? 0,
        batchCount: params.initialPublishState.batchCount ?? 0,
        inlineReviewIds: params.initialPublishState.inlineReviewIds
          ? [...params.initialPublishState.inlineReviewIds]
          : [],
      }),
      specialistOutcomes: {},
      briefFallback: false,
      judgmentDegraded: false,
    });
  }

  const workspaceTools = buildReviewWorkspaceTools({
    cfg,
    token: params.token,
    tokenExpiresAtTs: params.tokenExpiresAtTs,
    tokenTtlMs,
    workspace: params.workspace,
    refreshInstallationToken: params.refreshInstallationToken,
  });

  const briefTool = buildSpecialistBriefTool();
  const runState = createThreadPublishRunState({
    postedFingerprints: new Set(params.storedInlineFingerprints ?? []),
    postedInlineCount: params.initialPublishState?.postedInlineCount ?? 0,
    batchCount: params.initialPublishState?.batchCount ?? 0,
    inlineReviewIds: params.initialPublishState?.inlineReviewIds
      ? [...params.initialPublishState.inlineReviewIds]
      : [],
  });
  const summaryCapture = createSummaryCaptureState();
  const recordPublishStep = params.recordPublishStep ?? (async () => undefined);
  const publishCtx = {
    owner,
    repo,
    prNumber,
    headSha: params.headSha,
    hasDescriptionAgentBlock: params.hasDescriptionAgentBlock ?? false,
  };
  const controller = createOrchestratorSessionController();

  // Tools register before RunAbortScope exists; thread abortGate closes over this cell.
  const publishAbortGateCell = createPublishAbortGateCell();
  const threadTool = buildPublishThreadTool({
    cfg,
    ctx: publishCtx,
    token: workspaceTools.token,
    recordPublishStep,
    runState,
    cachedDiffIndex: workspaceTools.cachedDiffIndex,
    abortGate: () => publishAbortGateCell.current(),
  });
  const summaryTool = buildPublishSummaryTool({ state: summaryCapture });

  const reconTools = [...workspaceTools.piTools, briefTool.piTool];
  const reconExecutors = {
    ...workspaceTools.executors,
    [briefTool.piTool.name]: briefTool.executor,
  };
  const sessionTools = [
    ...workspaceTools.piTools,
    briefTool.piTool,
    threadTool.piTool,
    summaryTool.piTool,
  ];
  const sessionExecutors = {
    ...workspaceTools.executors,
    [briefTool.piTool.name]: briefTool.executor,
    [threadTool.piTool.name]: threadTool.executor,
    [summaryTool.piTool.name]: summaryTool.executor,
  };

  const session = await provider.createSession({
    cfg,
    cwd: params.cwd,
    systemPrompt: buildOrchestratorSystemPrompt(),
    tools: sessionTools,
    executors: sessionExecutors,
    refreshBeforeTool: workspaceTools.refreshBeforeTool,
  });

  const restoreThenRestrict = (
    tools: readonly (typeof sessionTools)[number][],
    executors: Record<string, (typeof sessionExecutors)[string]>,
  ): void => {
    session.restoreTools();
    session.restrictToTools(tools, executors);
  };
  restoreThenRestrict(reconTools, reconExecutors);

  const abort = createRunAbortScope({
    deadlineAtMs,
    now,
    sleep,
    session,
    shouldAbortPublish: params.shouldAbortPublish,
    publishAbortState: params.publishAbortState,
    shouldCancelRun: params.shouldCancelRun,
  });
  publishAbortGateCell.current = abort.publishGate;

  // One cheap-cancel monitor for the whole run (recon → summary). Sends rely on session.abort.
  const cheapCancel = abort.startCheapCancelMonitor();

  let lastText = "";
  const publishAttempts = 1;
  const specialistTicks = initialSpecialistTickState();

  const applySendResult = (result: OrchestratorSendResult): OrchestratorSendResult => {
    if (!result.ok && result.reason === "superseded") abort.markSuperseded();
    return result;
  };

  const sendTurn = async (args: {
    readonly prompt: string;
    readonly opts?: { readonly maxToolRounds?: number };
    readonly phase: string;
    readonly shouldSend?: () => boolean;
  }): Promise<OrchestratorSendResult> =>
    applySendResult(
      await sendOrchestratorTurnOnceWithRetry({
        session,
        prompt: args.prompt,
        opts: args.opts,
        phase: args.phase,
        shouldSend: args.shouldSend ?? abort.shouldKeepRunning,
        deadlineAtMs,
        now,
      }),
    );

  const maybeTick = async (runPhase?: "in_progress" | "superseded_rescheduled"): Promise<void> => {
    if (params.progressTick == null) return;
    await tickProgressComment({
      cfg,
      pool: params.progressTick.pool,
      workItemId: params.progressTick.workItemId,
      resourceKey: params.progressTick.resourceKey,
      owner,
      repo,
      prNumber,
      headSha: params.headSha,
      source: params.reviewSource ?? "auto",
      token: workspaceTools.token,
      specialistTicks,
      runPhase,
      summaryCommentIdHint: params.summaryCommentIdHint,
    });
  };

  try {
    const recon = await runReconPhase({
      session,
      abort,
      controller,
      briefTool,
      cachedDiffIndex: workspaceTools.cachedDiffIndex,
      prTitle: params.prTitle ?? "",
      prBody: params.prBody ?? "",
      trustedContext: params.trustedContext,
      userSupplement: params.userSupplement,
      owner,
      repo,
      prNumber,
      restoreThenRestrict,
      sendTurn,
    });
    lastText = recon.lastText;

    if (recon.superseded) {
      await maybeTick("superseded_rescheduled");
      return finish({
        cfg,
        lastText,
        published: false,
        publishAttempts,
        publishSuperseded: true,
        runState,
        specialistOutcomes: {},
        briefFallback: recon.briefFallback,
        judgmentDegraded: controller.isDegraded(),
      });
    }

    restoreThenRestrict([threadTool.piTool], {
      [threadTool.piTool.name]: threadTool.executor,
    });
    await maybeTick("in_progress");

    const judgment = await runJudgmentPhase({
      cfg,
      cwd: params.cwd,
      workspaceAgentCwd: params.workspace.agentCwd,
      brief: recon.brief,
      workspacePiTools: workspaceTools.piTools,
      workspaceExecutors: workspaceTools.executors,
      provider,
      abort,
      controller,
      threadTool,
      token: workspaceTools.token,
      ctx: publishCtx,
      recordPublishStep,
      runState,
      cachedDiffIndex: workspaceTools.cachedDiffIndex,
      specialistDispatchStaggerMs: params.specialistDispatchStaggerMs,
      specialistTicks,
      now,
      sleep,
      sendTurn,
      maybeTick,
    });
    if (judgment.lastText) lastText = judgment.lastText;

    if (judgment.superseded) {
      await maybeTick("superseded_rescheduled");
      return finish({
        cfg,
        lastText,
        published: false,
        publishAttempts,
        publishSuperseded: true,
        runState,
        specialistOutcomes: judgment.specialistOutcomes,
        briefFallback: recon.briefFallback,
        judgmentDegraded: controller.isDegraded(),
      });
    }

    if (judgment.allErrored && !judgment.allDeadlineErrored) {
      await publishReviewRunFailureNotice({
        cfg,
        token: workspaceTools.token,
        owner,
        repo,
        prNumber,
        reviewMode: "review",
        publishAttempts,
      });
      return finish({
        cfg,
        lastText,
        published: false,
        publishAttempts,
        publishSuperseded: false,
        runState,
        specialistOutcomes: judgment.specialistOutcomes,
        briefFallback: recon.briefFallback,
        judgmentDegraded: controller.isDegraded(),
      });
    }

    const deadlineHit = abort.deadlinePassed() || judgment.allDeadlineErrored;
    const summary = await runSummaryPhase({
      cfg,
      ctx: publishCtx,
      token: workspaceTools.token,
      recordPublishStep,
      runState,
      cachedDiffIndex: workspaceTools.cachedDiffIndex,
      abort,
      controller,
      summaryTool,
      brief: recon.brief,
      outcomes: judgment.outcomes,
      forceDeterministic: controller.isDegraded() || deadlineHit,
      deadlineReached: deadlineHit,
      shouldLinkToSummary: params.shouldLinkToSummary,
      summaryCommentIdHint: params.summaryCommentIdHint,
      owner,
      repo,
      prNumber,
      restoreThenRestrict,
      sendTurn,
    });
    if (summary.lastText) lastText = summary.lastText;

    if (summary.superseded) {
      await maybeTick("superseded_rescheduled");
      return finish({
        cfg,
        lastText,
        published: false,
        publishAttempts,
        publishSuperseded: true,
        runState,
        specialistOutcomes: judgment.specialistOutcomes,
        briefFallback: recon.briefFallback,
        judgmentDegraded: summary.judgmentDegraded,
      });
    }

    return finish({
      cfg,
      lastText,
      published: summary.published,
      publishAttempts,
      publishSuperseded: false,
      runState,
      specialistOutcomes: judgment.specialistOutcomes,
      briefFallback: recon.briefFallback,
      judgmentDegraded: summary.judgmentDegraded,
    });
  } finally {
    await cheapCancel.stop();
    abort.abortSessions();
    await session.dispose();
  }
}

function finish(args: {
  readonly cfg: Config;
  readonly lastText: string;
  readonly published: boolean;
  readonly publishAttempts: number;
  readonly publishSuperseded: boolean;
  readonly runState: ThreadPublishRunState;
  readonly specialistOutcomes: SpecialistOutcomeSummary;
  readonly briefFallback: boolean;
  readonly judgmentDegraded: boolean;
}): ReviewRunResult {
  setReviewRunMetricFields({
    published: args.published,
    publishAttempts: args.publishAttempts,
    specialistOutcomes: args.specialistOutcomes,
    threadBatches: args.runState.batchCount,
    briefFallback: args.briefFallback,
    judgmentDegraded: args.judgmentDegraded,
  });
  logReviewRunCompleted();
  return {
    lastAssistant: assistantFromText(args.cfg, args.lastText, args.cfg.agentProvider),
    published: args.published,
    publishAttempts: args.publishAttempts,
    publishSuperseded: args.publishSuperseded,
  };
}
