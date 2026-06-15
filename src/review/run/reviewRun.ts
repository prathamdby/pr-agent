import { logInfo, logWarn } from "../../evlog.js";
import { assistantFromText, runSubmitOnlyRound } from "../../agentRun/sessionHelpers.js";
import {
  runStructuredAgentLoop,
  runValidationRepairLoop,
  type StructuredAgentPhase,
} from "../../agentRun/structuredAgentLoop.js";
import { resolveAgentRunnerProvider } from "../../agent/providers/index.js";
import { renderAnchorMenuBlock } from "../placement/reviewDiffIndex.js";
import { PRE_SUBMIT_REMINDER, PRE_SUBMIT_ROUND0_PROMPT } from "../prompts/reviewPromptBlocks.js";
import {
  PROSE_ONLY_NUDGE,
  PUBLISH_RECOVERY_PROMPTS,
  PUBLISH_RECOVERY_ROUNDS,
  VALIDATION_REPAIR_ROUNDS,
  type ReviewPhase,
} from "../../settings/index.js";
import { REVIEW_PAYLOAD_MINIMAL_EXAMPLE } from "../reviewSchema.js";
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

export type { ReviewRunParams, ReviewRunResult } from "./reviewRunTypes.js";

export async function runFullPrReview(params: ReviewRunParams): Promise<ReviewRunResult> {
  if (!Number.isFinite(params.tokenExpiresAtTs)) {
    throw new Error("tokenExpiresAtTs must be a finite timestamp in milliseconds");
  }
  if (!Number.isFinite(params.tokenTtlMs) || params.tokenTtlMs <= 0) {
    throw new Error("tokenTtlMs must be a positive finite duration in milliseconds");
  }

  const { cfg, owner, repo, prNumber } = params;
  const reviewMode = params.mode ?? "review";
  const providerName = cfg.agentProvider;
  initReviewRunMetrics({
    provider: providerName,
    model: cfg.piModel,
    mode: reviewMode,
  });

  const setup = buildReviewRunSetup({ ...params, reviewMode });
  const runner = resolveAgentRunnerProvider(cfg);
  const session = await runner.createSession({
    cfg,
    cwd: params.cwd,
    systemPrompt: setup.systemPrompt,
    tools: setup.piTools,
    executors: setup.executors,
    refreshBeforeTool: setup.refreshBeforeTool,
  });

  let lastText = "";
  let publishAttempts = 0;

  const sendSubmitOnlyRepair = async (prompt: string): Promise<string> =>
    runSubmitOnlyRound(session, buildSubmitOnlyReviewSessionTools(setup), prompt);

  const runValidationRepair = async () => {
    await runValidationRepairLoop({
      rounds: VALIDATION_REPAIR_ROUNDS,
      shouldContinue: () => shouldContinueReviewRun(setup),
      getValidationError: () => setup.submitState.lastValidationError,
      clearValidationError: () => {
        setup.submitState.lastValidationError = null;
      },
      repair: async (validationError) => {
        lastText = await sendSubmitOnlyRepair(
          [
            validationError,
            "Fix the payload and call submitReview again with a complete ReviewPayload.",
            `Minimal valid example:\n${JSON.stringify(REVIEW_PAYLOAD_MINIMAL_EXAMPLE, null, 2)}`,
          ].join("\n\n"),
        );
      },
    });
  };

  const runInvestigationPhase = async () => {
    const investigationOpts = { maxToolRounds: cfg.maxToolRounds };
    lastText = (await session.send(setup.userContent, investigationOpts)).text;
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
      session.restrictToTools(submitOnly.piTools, submitOnly.executors);
    }
    for (
      let round = 0;
      round < PUBLISH_RECOVERY_ROUNDS && shouldContinueReviewRun(setup);
      round++
    ) {
      lastText = (
        await session.send(
          [
            prompt,
            `Minimal valid ReviewPayload example:\n${JSON.stringify(REVIEW_PAYLOAD_MINIMAL_EXAMPLE, null, 2)}`,
          ].join("\n\n"),
        )
      ).text;
      if (!shouldContinueReviewRun(setup)) break;
    }
    if (shouldContinueReviewRun(setup)) {
      recordReviewMetric({ kind: "phase_enter", phase: "validation_repair" });
      await runValidationRepair();
    }
    if (isLastAttempt) {
      session.restoreTools();
    }
  };

  try {
    const phases: StructuredAgentPhase<ReviewPhase>[] =
      cfg.maxReviewPublishAttempts > 0
        ? [
            { name: "investigation", run: runInvestigationPhase },
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
    publishAttempts = phases.length > 0 ? 1 : 0;
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
  } finally {
    await session.dispose();
  }

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
}
