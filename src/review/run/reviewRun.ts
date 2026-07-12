import { logInfo, logWarn } from "../../evlog.js";
import { assistantFromText, runSubmitOnlyRound } from "../../agentRun/sessionHelpers.js";
import {
  runStructuredAgentLoop,
  runValidationRepairLoop,
  type StructuredAgentPhase,
} from "../../agentRun/structuredAgentLoop.js";
import { resolveAgentRunnerProvider } from "../../agent/providers/index.js";
import type { AgentRunnerSession } from "../../agent/providers/interface.js";
import { renderAnchorMenuBlock } from "../placement/reviewDiffIndex.js";
import {
  PRE_SUBMIT_REMINDER,
  PRE_SUBMIT_ROUND0_PROMPT,
  PUBLISH_RECOVERY_COMPACT_REMINDER,
  VALIDATION_REPAIR_REMINDER,
  VALIDATION_REPAIR_ROUND0_SUFFIX,
} from "../prompts/reviewPromptBlocks.js";
import {
  PROSE_ONLY_NUDGE,
  PUBLISH_RECOVERY_PROMPTS,
  PUBLISH_RECOVERY_ROUNDS,
  REVIEW_CANCELLATION_POLL_MS,
  TOKEN_FRESHNESS_BUFFER_MS,
  VALIDATION_REPAIR_ROUNDS,
  type ReviewPhase,
} from "../../settings/index.js";
import { REVIEW_PAYLOAD_MINIMAL_EXAMPLE, type ReviewMode } from "../reviewSchema.js";
import type { ReviewRunParams, ReviewRunResult } from "./reviewRunTypes.js";
import { publishReviewRunFailureNotice } from "./reviewRunFallback.js";
import {
  initReviewRunMetrics,
  logReviewRunCompleted,
  recordReviewMetric,
  setReviewRunMetricFields,
} from "./reviewRunMetrics.js";
import {
  buildReviewRunSetup,
  buildSubmitOnlyReviewSessionTools,
  shouldContinueReviewRun,
} from "./reviewRunSetup.js";
import { sendReviewAgentTurn } from "./reviewRunAgentSend.js";
import {
  buildSynthesisContext,
  runReviewerEnsemble,
  validateHighRiskFindings,
} from "./reviewEnsemble.js";

export type { ReviewRunParams, ReviewRunResult } from "./reviewRunTypes.js";

function tokenTtlMsOrDefault(value: number | undefined, mode: ReviewMode): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  logWarn("review_token_ttl_defaulted", { mode });
  return TOKEN_FRESHNESS_BUFFER_MS;
}

export async function runFullPrReview(params: ReviewRunParams): Promise<ReviewRunResult> {
  if (!Number.isFinite(params.tokenExpiresAtTs)) {
    throw new Error("tokenExpiresAtTs must be a finite timestamp in milliseconds");
  }

  const { cfg, owner, repo, prNumber } = params;
  const reviewMode = params.mode ?? "review";
  const tokenTtlMs = tokenTtlMsOrDefault(params.tokenTtlMs, reviewMode);
  const providerName = cfg.agentProvider;
  initReviewRunMetrics({
    provider: providerName,
    model: cfg.piModel,
    mode: reviewMode,
  });

  const setup = buildReviewRunSetup({ ...params, tokenTtlMs, reviewMode });
  const runner = resolveAgentRunnerProvider(cfg);
  const submitTool = setup.piTools.find((tool) => tool.name === "submitReview");
  const readOnlyTools = setup.piTools.filter((tool) => tool.name !== "submitReview");
  const { submitReview: _submitReview, ...readOnlyExecutors } = setup.executors;
  if (!submitTool || !_submitReview) {
    throw new Error("Review orchestrator requires submitReview");
  }
  const abortController = new AbortController();
  let session: AgentRunnerSession | undefined;
  let lastText = "";
  let publishAttempts = 0;
  let hasSentMinimalExample = false;
  let abortCheck: Promise<boolean> | undefined;
  let cancellationWatcher: Promise<void> | undefined;
  let cancelCancellationDelay: (() => void) | undefined;

  const finish = (): ReviewRunResult => {
    setReviewRunMetricFields({
      published: setup.submitState.published,
      publishAttempts,
    });
    logReviewRunCompleted();
    return {
      lastAssistant: assistantFromText(cfg, lastText, providerName),
      published: setup.submitState.published,
      publishAttempts,
      publishSuperseded: setup.submitState.publishSuperseded,
    };
  };

  const abortIfRequested = async (activeSession?: AgentRunnerSession): Promise<boolean> => {
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
    try {
      await activeSession?.cancel();
    } catch (error) {
      logWarn("review_session_cancel_failed", {
        mode: reviewMode,
        owner,
        repo,
        pr: prNumber,
        message: error instanceof Error ? error.message : String(error),
      });
    }
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
        if (await abortIfRequested(session)) return;
      }
    })();
  };

  try {
    if (await abortIfRequested()) return finish();
    startCancellationWatcher();
    const ensemble = await runReviewerEnsemble({
      cfg,
      runner,
      cwd: params.cwd,
      userContent: setup.userContent,
      readOnlyTools,
      readOnlyExecutors,
      refreshBeforeTool: setup.refreshBeforeTool,
      signal: abortController.signal,
    });
    if (await abortIfRequested()) return finish();
    if (ensemble.failed.includes("correctness") || ensemble.failed.includes("security")) {
      throw new Error("Required review coverage did not complete");
    }
    const validation = await validateHighRiskFindings({
      cfg,
      runner,
      cwd: params.cwd,
      reports: ensemble.reports,
      readOnlyTools,
      readOnlyExecutors,
      refreshBeforeTool: setup.refreshBeforeTool,
      signal: abortController.signal,
    });
    if (await abortIfRequested()) return finish();
    const synthesisInput = {
      ...ensemble,
      reports: validation.reports,
      validationTruncatedCandidates: validation.truncatedCandidates,
    };
    const orchestratorSession = await runner.createSession({
      cfg,
      cwd: params.cwd,
      signal: abortController.signal,
      systemPrompt: setup.systemPrompt,
      tools: setup.piTools,
      executors: setup.executors,
      refreshBeforeTool: setup.refreshBeforeTool,
    });
    session = orchestratorSession;
    if (await abortIfRequested(orchestratorSession)) return finish();

    const minimalExampleBlock = () =>
      `Minimal valid example:\n${JSON.stringify(REVIEW_PAYLOAD_MINIMAL_EXAMPLE, null, 2)}`;

    const takeMinimalExampleBlock = (): string | null => {
      if (hasSentMinimalExample) return null;
      hasSentMinimalExample = true;
      return minimalExampleBlock();
    };

    const sendSubmitOnlyRepair = async (prompt: string): Promise<string> => {
      if (await abortIfRequested(orchestratorSession)) return "";
      const text = await runSubmitOnlyRound(
        orchestratorSession,
        buildSubmitOnlyReviewSessionTools(setup),
        prompt,
        sendReviewAgentTurn,
      );
      await abortIfRequested(orchestratorSession);
      return text;
    };

    const runValidationRepair = async () => {
      await runValidationRepairLoop({
        rounds: VALIDATION_REPAIR_ROUNDS,
        shouldContinue: () => shouldContinueReviewRun(setup),
        getValidationError: () => setup.submitState.lastValidationError,
        clearValidationError: () => {
          setup.submitState.lastValidationError = null;
        },
        repair: async (validationError) => {
          const exampleBlock = takeMinimalExampleBlock();
          const repairSuffix = exampleBlock
            ? VALIDATION_REPAIR_ROUND0_SUFFIX
            : VALIDATION_REPAIR_REMINDER;
          lastText = await sendSubmitOnlyRepair(
            [validationError, repairSuffix, exampleBlock].filter(Boolean).join("\n\n"),
          );
        },
      });
    };

    const runInvestigationPhase = async () => {
      if (await abortIfRequested(orchestratorSession)) return;
      const investigationOpts = { maxToolRounds: cfg.maxToolRounds };
      lastText = (
        await sendReviewAgentTurn(
          orchestratorSession,
          [setup.userContent, buildSynthesisContext(synthesisInput)].join("\n\n"),
          investigationOpts,
        )
      ).text;
      await abortIfRequested(orchestratorSession);
      if (!shouldContinueReviewRun(setup)) return;

      let anchorMenuBlock: string | undefined;
      if (
        cfg.reviewInjectAnchorMenu &&
        setup.cachedDiffIndex.files.size > 0 &&
        shouldContinueReviewRun(setup)
      ) {
        anchorMenuBlock = renderAnchorMenuBlock(setup.cachedDiffIndex, {
          maxFiles: cfg.reviewAnchorMenuMaxFiles,
          maxRangesPerFile: cfg.reviewAnchorMenuMaxRangesPerFile,
        });
      }

      if (shouldContinueReviewRun(setup)) {
        recordReviewMetric({ kind: "prose_only", phase: "pre_submit" });
        for (let round = 0; round < 2 && shouldContinueReviewRun(setup); round++) {
          const prompt =
            round === 0
              ? [anchorMenuBlock, PRE_SUBMIT_ROUND0_PROMPT, PROSE_ONLY_NUDGE]
                  .filter(Boolean)
                  .join("\n\n")
              : PRE_SUBMIT_REMINDER;
          lastText = await sendSubmitOnlyRepair(prompt);
          if (!shouldContinueReviewRun(setup)) break;
        }
      }

      if (shouldContinueReviewRun(setup)) {
        recordReviewMetric({ kind: "phase_enter", phase: "validation_repair" });
        await runValidationRepair();
      }
    };

    const runPublishRecoveryPhase = async (attemptIndex: number) => {
      if (!shouldContinueReviewRun(setup)) return;
      const prompt =
        PUBLISH_RECOVERY_PROMPTS[attemptIndex - 1] ??
        PUBLISH_RECOVERY_PROMPTS[PUBLISH_RECOVERY_PROMPTS.length - 1];
      const isLastAttempt = attemptIndex >= cfg.maxReviewPublishAttempts - 1;
      logInfo("review_publish_retry", {
        mode: reviewMode,
        attempt: attemptIndex + 1,
        maxAttempts: cfg.maxReviewPublishAttempts,
        submitOnly: isLastAttempt,
        owner,
        repo,
        pr: prNumber,
      });
      if (isLastAttempt) {
        const submitOnly = buildSubmitOnlyReviewSessionTools(setup);
        orchestratorSession.restrictToTools(submitOnly.piTools, submitOnly.executors);
      }
      for (
        let round = 0;
        round < PUBLISH_RECOVERY_ROUNDS && shouldContinueReviewRun(setup);
        round++
      ) {
        const exampleBlock = takeMinimalExampleBlock();
        const recoverySuffix = exampleBlock ?? PUBLISH_RECOVERY_COMPACT_REMINDER;
        if (await abortIfRequested(orchestratorSession)) break;
        lastText = (
          await sendReviewAgentTurn(orchestratorSession, [prompt, recoverySuffix].join("\n\n"))
        ).text;
        await abortIfRequested(orchestratorSession);
        if (!shouldContinueReviewRun(setup)) break;
      }
      if (shouldContinueReviewRun(setup)) {
        recordReviewMetric({ kind: "phase_enter", phase: "validation_repair" });
        await runValidationRepair();
      }
      if (isLastAttempt) {
        orchestratorSession.restoreTools();
      }
    };

    const phases: StructuredAgentPhase<ReviewPhase>[] =
      cfg.maxReviewPublishAttempts > 0
        ? [
            {
              name: "investigation",
              run: async () => {
                publishAttempts = 1;
                await runInvestigationPhase();
              },
            },
            ...Array.from({ length: cfg.maxReviewPublishAttempts - 1 }, (_, index) => ({
              name: "publish_recovery" as const,
              run: async () => {
                const attempt = index + 1;
                publishAttempts = attempt + 1;
                await runPublishRecoveryPhase(attempt);
              },
            })),
          ]
        : [];
    await runStructuredAgentLoop({
      phases,
      shouldContinue: () => shouldContinueReviewRun(setup),
      onPhaseEnter: (phase) => recordReviewMetric({ kind: "phase_enter", phase }),
    });

    if (!setup.submitState.published) {
      const willRescheduleStaleHead =
        params.publishAbortState?.staleHead === true &&
        params.reviewSource === "slash" &&
        !params.staleHeadRescheduled;
      logWarn("review_publish_exhausted", {
        mode: reviewMode,
        attempts: publishAttempts,
        maxAttempts: cfg.maxReviewPublishAttempts,
        owner,
        repo,
        pr: prNumber,
        willRescheduleStaleHead,
      });
      if (!willRescheduleStaleHead && shouldContinueReviewRun(setup)) {
        recordReviewMetric({ kind: "phase_enter", phase: "plaintext_fallback" });
        await publishReviewRunFailureNotice({
          cfg,
          setup,
          owner,
          repo,
          prNumber,
          reviewMode,
          publishAttempts,
        });
      }
    }
    return finish();
  } finally {
    abortController.abort();
    cancelCancellationDelay?.();
    await cancellationWatcher;
    await session?.dispose();
  }
}
