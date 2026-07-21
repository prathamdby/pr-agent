import type { Config } from "../../config.js";
import { AppError } from "../../errors/appError.js";
import { logInfo, logWarn } from "../../evlog.js";
import { assistantFromText } from "../../agentRun/sessionHelpers.js";
import { runValidationRepairLoop } from "../../agentRun/structuredAgentLoop.js";
import {
  resolveAgentRunnerProvider,
  type AgentRunnerProvider,
} from "../../agent/providers/index.js";
import {
  JUDGMENT_DEGRADED_NOTE,
  MAX_TOOL_ROUNDS,
  ORCHESTRATOR_JUDGMENT_MAX_TOOL_ROUNDS,
  PUBLISH_RECOVERY_ROUNDS,
  TOKEN_FRESHNESS_BUFFER_MS,
  VALIDATION_REPAIR_ROUNDS,
} from "../../settings/index.js";
import type { ReviewRunParams, ReviewRunResult } from "../run/reviewRunTypes.js";
import {
  initReviewRunMetrics,
  logReviewRunCompleted,
  setReviewRunMetricFields,
} from "../run/reviewRunMetrics.js";
import { initialSpecialistTickState } from "../run/progressComment.js";
import { publishReviewRunFailureNotice } from "../run/reviewRunFallback.js";
import { buildReviewWorkspaceTools } from "../run/reviewWorkspaceTools.js";
import type { RecordPublishStepWithCoordination } from "../publish/summaryCommentCoordination.js";
import { buildSpecialistBriefTool, renderBriefMessage, type SpecialistBrief } from "./briefTool.js";
import { buildDeterministicBrief, renderChangedFilesSummary } from "./briefFallback.js";
import { pumpSpecialistCompletions } from "./completionPump.js";
import {
  computeRunDeadlineAtMs,
  resolveSpecialistDispatchStaggerMs,
  specialistTimeoutMs,
} from "./deadlineBudget.js";
import {
  accumulateUnjudgedReportAsSummaryOnly,
  coverageNotes,
  publishDeterministicSummary,
  publishUnjudgedReport,
} from "./degradedPublish.js";
import {
  checkAbortGate,
  isDeadlineSpecialistError,
  markOrchestratorSuperseded,
  startPendingSpecialistsCancelMonitor,
  type AbortGateKind,
} from "./orchestratorAbortGate.js";
import {
  sendOrchestratorTurnOnceWithRetry,
  type OrchestratorSendResult,
} from "./orchestratorSend.js";
import {
  buildOrchestratorSystemPrompt,
  renderJudgmentTurn,
  renderReconInstruction,
  renderSynthesisTurn,
} from "./prompts/orchestratorPrompts.js";
import { buildPublishSummaryTool, createSummaryPublishState } from "./publishSummaryTool.js";
import {
  buildPublishThreadTool,
  createThreadPublishRunState,
  type ThreadPublishRunState,
} from "./publishThreadTool.js";
import { refreshInstallationTokenIfNearExpiry } from "./refreshInstallationTokenIfNearExpiry.js";
import { SPECIALIST_IDS, type SpecialistId, type SpecialistOutcome } from "./specialistReport.js";
import { runSpecialist } from "./specialistRun.js";
import { tickProgressComment } from "./stubTick.js";

function tokenTtlMsOrDefault(value: number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  logWarn("review_token_ttl_defaulted", { mode: "review" });
  return TOKEN_FRESHNESS_BUFFER_MS;
}

function asCoordinatedRecordPublishStep(
  record: ReviewRunParams["recordPublishStep"],
): RecordPublishStepWithCoordination {
  const fn = (record ?? (async () => undefined)) as RecordPublishStepWithCoordination;
  return fn;
}

const PUBLISH_THREAD_SUBMIT_NUDGE =
  "Call publish_thread exactly once now with the worthy findings, or an empty findings array if nothing should publish.";

/**
 * Orchestrated review: one recon/judgment/synthesis session plus four parallel specialists.
 * Same {@link ReviewRunParams} / {@link ReviewRunResult} contract as the former V1 loop.
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
  const staggerMs = resolveSpecialistDispatchStaggerMs(params.specialistDispatchStaggerMs);

  initReviewRunMetrics({
    provider: cfg.agentProvider,
    model: cfg.piModel,
    mode: "review",
  });

  // Idempotent resume when this work item already published its summary.
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
  const summaryState = createSummaryPublishState({
    published: params.initialPublishState?.published ?? false,
  });
  const recordPublishStep = asCoordinatedRecordPublishStep(params.recordPublishStep);
  const publishCtx = {
    owner,
    repo,
    prNumber,
    headSha: params.headSha,
    hasDescriptionAgentBlock: params.hasDescriptionAgentBlock ?? false,
  };

  const threadTool = buildPublishThreadTool({
    cfg,
    ctx: publishCtx,
    getToken: workspaceTools.getToken,
    getTokenExpiresAtTs: workspaceTools.getTokenExpiresAtTs,
    refreshInstallationToken: workspaceTools.refreshInstallationToken,
    refreshNearExpiry: workspaceTools.refreshNearExpiry,
    recordPublishStep,
    runState,
    cachedDiffIndex: workspaceTools.cachedDiffIndex,
    shouldAbortPublish: params.shouldAbortPublish,
    publishAbortState: params.publishAbortState,
  });

  let partialCoverageNote: string | undefined;
  let coveragePartial = false;
  let judgmentDegraded = false;
  let briefFallback = false;
  /** After recon send dies twice, never call orchestrator send again (decision 19). */
  let skipOrchestratorSends = false;

  const rebuildSummaryTool = () =>
    buildPublishSummaryTool({
      cfg,
      ctx: publishCtx,
      getToken: workspaceTools.getToken,
      getTokenExpiresAtTs: workspaceTools.getTokenExpiresAtTs,
      refreshInstallationToken: workspaceTools.refreshInstallationToken,
      refreshNearExpiry: workspaceTools.refreshNearExpiry,
      recordPublishStep,
      runState,
      state: summaryState,
      cachedDiffIndex: workspaceTools.cachedDiffIndex,
      partialCoverageNote,
      coveragePartial,
      shouldAbortPublish: params.shouldAbortPublish,
      publishAbortState: params.publishAbortState,
      shouldLinkToSummary: params.shouldLinkToSummary,
      summaryCommentIdHint: params.summaryCommentIdHint,
    });

  let summaryTool = rebuildSummaryTool();

  const reconTools = [...workspaceTools.piTools, briefTool.piTool];
  const reconExecutors = {
    ...workspaceTools.executors,
    [briefTool.piTool.name]: briefTool.executor,
  };

  const session = await provider.createSession({
    cfg,
    cwd: params.cwd,
    systemPrompt: buildOrchestratorSystemPrompt(),
    tools: reconTools,
    executors: reconExecutors,
    refreshBeforeTool: workspaceTools.refreshBeforeTool,
  });

  const abortController = new AbortController();
  let publishSuperseded = false;
  let lastText = "";
  let publishAttempts = 0;
  const specialistTicks = initialSpecialistTickState();
  const specialistOutcomes: Record<string, string> = {};

  const deadlinePassed = (): boolean => now() >= deadlineAtMs;
  const shouldKeepRunning = (): boolean => !publishSuperseded && !deadlinePassed();

  const markSuperseded = (): void => {
    markOrchestratorSuperseded({
      abortController,
      session,
      setSuperseded: () => {
        publishSuperseded = true;
      },
    });
  };

  const gate = async (): Promise<AbortGateKind> =>
    checkAbortGate({
      alreadySuperseded: publishSuperseded,
      deadlinePassed: deadlinePassed(),
      shouldAbortPublish: params.shouldAbortPublish,
      onSupersede: markSuperseded,
    });

  /** Any send-phase superseded must mark immediately; deadline must not (decision 26). */
  const applySendResult = (result: OrchestratorSendResult): OrchestratorSendResult => {
    if (!result.ok && result.reason === "superseded") {
      markSuperseded();
    }
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
        shouldSend: args.shouldSend ?? shouldKeepRunning,
        deadlineAtMs,
        now,
        sleep,
        shouldAbortExternal: params.shouldCancelRun,
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
      getToken: workspaceTools.getToken,
      getTokenExpiresAtTs: workspaceTools.getTokenExpiresAtTs,
      refreshInstallationToken: workspaceTools.refreshInstallationToken,
      refreshNearExpiry: workspaceTools.refreshNearExpiry,
      specialistTicks,
      runPhase,
      summaryCommentIdHint: params.summaryCommentIdHint,
    });
  };

  const restoreThenRestrict = (
    tools: typeof reconTools,
    executors: typeof reconExecutors,
  ): void => {
    session.restoreTools();
    session.restrictToTools(tools, executors);
  };

  const publishTokenHooks = {
    getToken: workspaceTools.getToken,
    getTokenExpiresAtTs: workspaceTools.getTokenExpiresAtTs,
    refreshInstallationToken: workspaceTools.refreshInstallationToken,
    refreshNearExpiry: workspaceTools.refreshNearExpiry,
  };

  try {
    const reconPrompt = [
      renderReconInstruction({
        prTitle: params.prTitle ?? "",
        prBody: params.prBody ?? "",
        changedFilesSummary: renderChangedFilesSummary(workspaceTools.cachedDiffIndex),
      }),
      params.trustedContext ? `\n${params.trustedContext}\n` : "",
      params.userSupplement ? `\n${params.userSupplement}\n` : "",
    ]
      .filter((part) => part.length > 0)
      .join("\n");

    publishAttempts = 1;
    const reconSend = await sendTurn({
      prompt: reconPrompt,
      opts: { maxToolRounds: MAX_TOOL_ROUNDS },
      phase: "recon",
    });
    if (reconSend.ok) {
      lastText = reconSend.turn.text;
    } else {
      // Recon send failed: degrade and never call orchestrator send again.
      judgmentDegraded = true;
      skipOrchestratorSends = true;
      logWarn("review_recon_degraded", {
        owner,
        repo,
        pr: prNumber,
        message: reconSend.error.message,
        reason: reconSend.reason,
      });
    }

    if (!skipOrchestratorSends && briefTool.getBrief() == null && shouldKeepRunning()) {
      await runValidationRepairLoop({
        rounds: VALIDATION_REPAIR_ROUNDS,
        shouldContinue: () =>
          !skipOrchestratorSends && shouldKeepRunning() && briefTool.getBrief() == null,
        getValidationError: () =>
          briefTool.getLastError() ??
          (briefTool.getBrief() == null
            ? "Call submit_specialist_brief exactly once with a complete specialist brief."
            : null),
        clearValidationError: () => briefTool.clearLastError(),
        repair: async (validationError) => {
          restoreThenRestrict([briefTool.piTool], {
            [briefTool.piTool.name]: briefTool.executor,
          });
          try {
            const repairSend = await sendTurn({
              prompt: validationError,
              phase: "recon_repair",
            });
            if (repairSend.ok) lastText = repairSend.turn.text;
            else {
              judgmentDegraded = true;
              skipOrchestratorSends = true;
            }
          } finally {
            session.restoreTools();
          }
        },
      });
    }

    let brief: SpecialistBrief =
      briefTool.getBrief() ??
      (() => {
        briefFallback = true;
        logWarn("review_brief_fallback", { owner, repo, pr: prNumber });
        return buildDeterministicBrief({
          prTitle: params.prTitle ?? "",
          prBody: params.prBody ?? "",
          cachedDiffIndex: workspaceTools.cachedDiffIndex,
        });
      })();

    const postReconGate = await gate();
    if (postReconGate === "superseded") {
      await maybeTick("superseded_rescheduled");
      return finish({
        cfg,
        lastText,
        published: false,
        publishAttempts,
        publishSuperseded: true,
        runState,
        specialistOutcomes,
        briefFallback,
        judgmentDegraded,
      });
    }

    restoreThenRestrict([threadTool.piTool], {
      [threadTool.piTool.name]: threadTool.executor,
    });

    await maybeTick("in_progress");

    const dispatchNowMs = now();
    const pending = new Map<SpecialistId, Promise<SpecialistOutcome>>();
    for (let index = 0; index < SPECIALIST_IDS.length; index++) {
      const specialist = SPECIALIST_IDS[index]!;
      const timeoutMs = specialistTimeoutMs({
        nowMs: dispatchNowMs,
        deadlineAtMs,
        configTimeoutMs: cfg.reviewSpecialistTimeoutMs,
        pendingCount: SPECIALIST_IDS.length,
      });
      pending.set(
        specialist,
        runSpecialist({
          cfg,
          cwd: params.cwd ?? params.workspace.agentCwd,
          specialist,
          briefMessage: renderBriefMessage(brief, specialist),
          workspaceTools: {
            piTools: workspaceTools.piTools,
            executors: workspaceTools.executors,
          },
          timeoutMs,
          shouldContinue: shouldKeepRunning,
          deadlineAtMs,
          signal: abortController.signal,
          startDelayMs: index * staggerMs,
          now,
          sleep,
          provider,
        }),
      );
    }

    const unjudgedReports: Extract<SpecialistOutcome, { kind: "report" }>[] = [];

    const ensureThreadPublishedOrDegrade = async (
      outcome: Extract<SpecialistOutcome, { kind: "report" }>,
    ): Promise<void> => {
      if (threadTool.hadSuccessfulCallThisTurn()) return;
      if (!skipOrchestratorSends && shouldKeepRunning()) {
        const repairSend = await sendTurn({
          prompt: PUBLISH_THREAD_SUBMIT_NUDGE,
          opts: { maxToolRounds: ORCHESTRATOR_JUDGMENT_MAX_TOOL_ROUNDS },
          phase: "judgment_submit_repair",
        });
        if (repairSend.ok) lastText = repairSend.turn.text;
        else {
          logWarn("review_judgment_submit_repair_failed", {
            specialist: outcome.specialist,
            message: repairSend.error.message,
          });
        }
      }
      if (threadTool.hadSuccessfulCallThisTurn()) return;
      unjudgedReports.push(outcome);
      logWarn("review_judgment_missing_publish_thread", {
        specialist: outcome.specialist,
      });
    };

    const handleOutcome = async (outcome: SpecialistOutcome): Promise<void> => {
      specialistOutcomes[outcome.specialist] = outcome.kind;

      const outcomeGate = await gate();
      if (outcomeGate === "superseded") return;

      switch (outcome.kind) {
        case "empty": {
          specialistTicks[outcome.specialist] = { phase: "no_findings" };
          await maybeTick("in_progress");
          return;
        }
        case "error": {
          specialistTicks[outcome.specialist] = { phase: "failed" };
          if (!runState.partialSpecialists.includes(outcome.specialist)) {
            runState.partialSpecialists.push(outcome.specialist);
          }
          coveragePartial = true;
          partialCoverageNote = coverageNotes({
            partialSpecialists: runState.partialSpecialists,
            judgmentDegraded,
          });
          summaryTool = rebuildSummaryTool();
          logWarn("review_specialist_failed", {
            specialist: outcome.specialist,
            message: outcome.error.message,
          });
          await maybeTick("in_progress");
          return;
        }
        case "report": {
          if (judgmentDegraded || skipOrchestratorSends || !shouldKeepRunning()) {
            unjudgedReports.push(outcome);
            return;
          }

          const beforePosted = runState.postedInlineCount;
          threadTool.beginTurn();
          const judgmentPrompt = renderJudgmentTurn(outcome, {
            previouslyAcceptedFindings: runState.acceptedFindings,
          });
          await refreshInstallationTokenIfNearExpiry({
            refreshNearExpiry: workspaceTools.refreshNearExpiry,
          });

          const judgmentSend = await sendTurn({
            prompt: judgmentPrompt,
            opts: { maxToolRounds: ORCHESTRATOR_JUDGMENT_MAX_TOOL_ROUNDS },
            phase: "judgment",
          });

          if (!judgmentSend.ok) {
            judgmentDegraded = true;
            unjudgedReports.push(outcome);
            logWarn("review_judgment_degraded", {
              specialist: outcome.specialist,
              message: judgmentSend.error.message,
            });
            return;
          }
          lastText = judgmentSend.turn.text;

          const afterJudgmentGate = await gate();
          if (afterJudgmentGate === "superseded") return;

          if (threadTool.getLastError() != null && shouldKeepRunning()) {
            await runValidationRepairLoop({
              rounds: 1,
              shouldContinue: () => shouldKeepRunning(),
              getValidationError: () => threadTool.getLastError(),
              clearValidationError: () => threadTool.clearLastError(),
              repair: async (validationError) => {
                const repairSend = await sendTurn({
                  prompt: validationError,
                  opts: { maxToolRounds: ORCHESTRATOR_JUDGMENT_MAX_TOOL_ROUNDS },
                  phase: "judgment_repair",
                });
                if (repairSend.ok) lastText = repairSend.turn.text;
                else {
                  judgmentDegraded = true;
                }
              },
            });
          }

          // Missing or invalid publish_thread: one submit repair, then deterministic batch fallback.
          await ensureThreadPublishedOrDegrade(outcome);

          const threadsPublished = Math.max(0, runState.postedInlineCount - beforePosted);
          if (!judgmentDegraded || threadTool.hadSuccessfulCallThisTurn()) {
            specialistTicks[outcome.specialist] = {
              phase: "done",
              threadsPublished,
            };
            await maybeTick("in_progress");
          }
          return;
        }
        default: {
          const _exhaustive: never = outcome;
          return _exhaustive;
        }
      }
    };

    const cancelMonitor = startPendingSpecialistsCancelMonitor({
      shouldCancelRun: params.shouldCancelRun,
      shouldContinue: () => !publishSuperseded,
      sleep,
      onCancel: markSuperseded,
    });

    let outcomes: SpecialistOutcome[];
    try {
      outcomes = await pumpSpecialistCompletions({
        pending,
        onOutcome: handleOutcome,
        // Keep consuming after the internal deadline so reports can flush as summary-only;
        // stop only on external supersede (decision 26).
        shouldContinue: () => !publishSuperseded,
        signal: abortController.signal,
      });
    } finally {
      await cancelMonitor.stop();
    }

    // Abort any still-running specialists on deadline / supersede
    if (!shouldKeepRunning() || deadlinePassed()) {
      if (!abortController.signal.aborted) abortController.abort();
      session.abort();
    }

    if (publishSuperseded) {
      await maybeTick("superseded_rescheduled");
      return finish({
        cfg,
        lastText,
        published: false,
        publishAttempts,
        publishSuperseded: true,
        runState,
        specialistOutcomes,
        briefFallback,
        judgmentDegraded,
      });
    }

    // Flush unjudged reports: after the internal deadline, summary-only (no GitHub threads).
    for (const report of unjudgedReports) {
      const flushGate = await gate();
      if (flushGate === "superseded") break;
      if (flushGate === "deadline" || deadlinePassed()) {
        accumulateUnjudgedReportAsSummaryOnly({
          outcome: report,
          runState,
          cachedDiffIndex: workspaceTools.cachedDiffIndex,
        });
      } else {
        await publishUnjudgedReport({
          outcome: report,
          cfg,
          ctx: publishCtx,
          ...publishTokenHooks,
          recordPublishStep,
          runState,
          cachedDiffIndex: workspaceTools.cachedDiffIndex,
          shouldAbortPublish: params.shouldAbortPublish,
          publishAbortState: params.publishAbortState,
        });
      }
      specialistTicks[report.specialist] = {
        phase: "done",
        threadsPublished: 0,
      };
    }

    const allErrored =
      outcomes.length === SPECIALIST_IDS.length && outcomes.every((item) => item.kind === "error");
    const allDeadlineErrored =
      allErrored &&
      outcomes.every((item) => item.kind === "error" && isDeadlineSpecialistError(item.error));

    // Genuine specialist failures publish a failure notice; deadline exhaustion continues to summary.
    if (allErrored && !allDeadlineErrored) {
      await publishReviewRunFailureNotice({
        cfg,
        ...publishTokenHooks,
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
        specialistOutcomes,
        briefFallback,
        judgmentDegraded,
      });
    }

    const forceDeterministicSummary =
      judgmentDegraded || skipOrchestratorSends || deadlinePassed() || allDeadlineErrored;
    partialCoverageNote = coverageNotes({
      partialSpecialists: runState.partialSpecialists,
      judgmentDegraded: forceDeterministicSummary,
    });
    coveragePartial = runState.partialSpecialists.length > 0;
    summaryTool = rebuildSummaryTool();

    if (forceDeterministicSummary) {
      const summaryGate = await gate();
      if (summaryGate !== "superseded" && !publishSuperseded) {
        await publishDeterministicSummary({
          cfg,
          ctx: publishCtx,
          ...publishTokenHooks,
          recordPublishStep,
          runState,
          cachedDiffIndex: workspaceTools.cachedDiffIndex,
          partialSpecialists: runState.partialSpecialists,
          judgmentDegraded: true,
          shouldAbortPublish: params.shouldAbortPublish,
          publishAbortState: params.publishAbortState,
          shouldLinkToSummary: params.shouldLinkToSummary,
          summaryCommentIdHint: params.summaryCommentIdHint,
        });
        summaryState.published = true;
        judgmentDegraded = true;
      }
    } else {
      restoreThenRestrict([summaryTool.piTool], {
        [summaryTool.piTool.name]: summaryTool.executor,
      });

      const emptySpecialists = outcomes
        .filter(
          (item): item is Extract<SpecialistOutcome, { kind: "empty" }> => item.kind === "empty",
        )
        .map((item) => item.specialist);

      const synthesisPrompt = renderSynthesisTurn({
        acceptedFindings: runState.acceptedFindings,
        partialSpecialists: runState.partialSpecialists,
        emptySpecialists,
        brief,
      });

      await refreshInstallationTokenIfNearExpiry({
        refreshNearExpiry: workspaceTools.refreshNearExpiry,
      });

      const synthesisSend = await sendTurn({
        prompt: synthesisPrompt,
        opts: { maxToolRounds: MAX_TOOL_ROUNDS },
        phase: "synthesis",
        shouldSend: () => shouldKeepRunning() && !summaryState.published,
      });

      if (synthesisSend.ok) {
        lastText = synthesisSend.turn.text;
        if (!summaryState.published) {
          for (
            let round = 0;
            round < PUBLISH_RECOVERY_ROUNDS && shouldKeepRunning() && !summaryState.published;
            round++
          ) {
            const recovery = await sendTurn({
              prompt:
                "Call publish_summary exactly once now with overview fields for the accepted findings.",
              opts: { maxToolRounds: MAX_TOOL_ROUNDS },
              phase: "synthesis_recovery",
              shouldSend: () => shouldKeepRunning() && !summaryState.published,
            });
            if (recovery.ok) lastText = recovery.turn.text;
            else break;
          }
        }
      }

      if (!summaryState.published && !publishSuperseded) {
        judgmentDegraded = true;
        await publishDeterministicSummary({
          cfg,
          ctx: publishCtx,
          ...publishTokenHooks,
          recordPublishStep,
          runState,
          cachedDiffIndex: workspaceTools.cachedDiffIndex,
          partialSpecialists: runState.partialSpecialists,
          judgmentDegraded: true,
          shouldAbortPublish: params.shouldAbortPublish,
          publishAbortState: params.publishAbortState,
          shouldLinkToSummary: params.shouldLinkToSummary,
          summaryCommentIdHint: params.summaryCommentIdHint,
        });
        summaryState.published = true;
        logInfo("review_synthesis_degraded", {
          owner,
          repo,
          pr: prNumber,
          note: JUDGMENT_DEGRADED_NOTE,
        });
      }
    }

    if (publishSuperseded) {
      await maybeTick("superseded_rescheduled");
      return finish({
        cfg,
        lastText,
        published: false,
        publishAttempts,
        publishSuperseded: true,
        runState,
        specialistOutcomes,
        briefFallback,
        judgmentDegraded,
      });
    }

    return finish({
      cfg,
      lastText,
      published: summaryState.published,
      publishAttempts,
      publishSuperseded,
      runState,
      specialistOutcomes,
      briefFallback,
      judgmentDegraded,
    });
  } finally {
    if (!abortController.signal.aborted) abortController.abort();
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
  readonly specialistOutcomes: Record<string, string>;
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
