import type { Config } from "../config.js";
import type { LocalPrWorkspace } from "../prWorkspace/index.js";
import { logInfo, logWarn } from "../evlog.js";
import { upsertReviewSummaryComment } from "../github/reviewPublish.js";
import { renderReviewFailureNotice } from "./progressComment.js";
import type { WorkSource } from "./workSource.js";
import { assistantFromText, runSubmitOnlyRound } from "../agentRun/sessionHelpers.js";
import { resolveAgentRunnerProvider } from "../agent/providers/index.js";
import { renderAnchorMenuBlock } from "./reviewDiffIndex.js";
import { PRE_SUBMIT_REMINDER, PRE_SUBMIT_ROUND0_PROMPT } from "./reviewPromptBlocks.js";
import {
  PROSE_ONLY_NUDGE,
  PUBLISH_RECOVERY_PROMPTS,
  PUBLISH_RECOVERY_ROUNDS,
  VALIDATION_REPAIR_ROUNDS,
  type ReviewPhase,
} from "../settings/index.js";
import {
  REVIEW_PAYLOAD_MINIMAL_EXAMPLE,
  reviewRetrySlashCommandForMode,
  reviewSummarySentinelForMode,
  type ReviewMode,
} from "./reviewSchema.js";
import type { ReviewRunResult } from "./reviewRun.js";
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

export async function runReviewHarness(params: {
  cfg: Config;
  token: string;
  tokenExpiresAtTs: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  reviewMode: ReviewMode;
  userSupplement?: string;
  trustedContext?: string;
  cwd?: string;
  workspace?: LocalPrWorkspace;
  shouldLinkToSummary?: boolean;
  summaryCommentIdHint?: number | null;
  initialPublishState?: {
    published?: boolean;
    inlinePublished?: boolean;
    inlineReviewId?: number | null;
  };
  recordPublishStep?: (
    step: "inline_review" | "summary_comment" | "labels",
    detail?: { githubId?: string | number; meta?: Record<string, unknown> },
  ) => Promise<void>;
  shouldAbortPublish?: () => Promise<boolean>;
  storedInlineFingerprints?: readonly string[];
  refreshInstallationToken?: () => Promise<{ token: string; expiresAtTs: number }>;
  reviewSource?: WorkSource;
  staleHeadRescheduled?: boolean;
  publishAbortState?: { staleHead?: boolean };
}): Promise<ReviewRunResult> {
  const { cfg, owner, repo, prNumber, reviewMode } = params;
  const providerName = cfg.agentProvider;
  initReviewRunMetrics({
    provider: providerName,
    model: cfg.piModel,
    mode: reviewMode,
  });

  const setup = buildReviewRunSetup(params);
  const runner = resolveAgentRunnerProvider(cfg);
  let session = await runner.createSession({
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

  const runValidationRepair = async (phase: ReviewPhase) => {
    recordReviewMetric({ kind: "phase_enter", phase });
    for (
      let repair = 0;
      repair < VALIDATION_REPAIR_ROUNDS && shouldContinueReviewRun(setup);
      repair++
    ) {
      const validationError = setup.submitState.lastValidationError;
      if (!validationError) break;
      setup.submitState.lastValidationError = null;
      lastText = await sendSubmitOnlyRepair(
        [
          validationError,
          "Fix the payload and call submitReview again with a complete ReviewPayload.",
          `Minimal valid example:\n${JSON.stringify(REVIEW_PAYLOAD_MINIMAL_EXAMPLE, null, 2)}`,
        ].join("\n\n"),
      );
      if (!shouldContinueReviewRun(setup)) break;
    }
  };

  const runInvestigationPhase = async () => {
    recordReviewMetric({ kind: "phase_enter", phase: "investigation" });
    const investigationOpts = { maxToolRounds: cfg.maxToolRounds };
    lastText = (await session.send(setup.userContent, investigationOpts)).text;
    if (!shouldContinueReviewRun(setup)) return;

    if (
      cfg.reviewInjectAnchorMenu &&
      setup.cachedDiffIndex.files.size > 0 &&
      shouldContinueReviewRun(setup)
    ) {
      const anchorMenu = renderAnchorMenuBlock(setup.cachedDiffIndex, {
        maxFiles: cfg.reviewAnchorMenuMaxFiles,
        maxRangesPerFile: cfg.reviewAnchorMenuMaxRangesPerFile,
      });
      if (anchorMenu) {
        lastText = (await session.send(anchorMenu, investigationOpts)).text;
        if (!shouldContinueReviewRun(setup)) return;
      }
    }

    if (shouldContinueReviewRun(setup)) {
      recordReviewMetric({ kind: "prose_only", phase: "pre_submit" });
      for (let round = 0; round < 2 && shouldContinueReviewRun(setup); round++) {
        const prompt =
          round === 0
            ? [PRE_SUBMIT_ROUND0_PROMPT, PROSE_ONLY_NUDGE].join("\n\n")
            : PRE_SUBMIT_REMINDER;
        lastText = await sendSubmitOnlyRepair(prompt);
        if (!shouldContinueReviewRun(setup)) break;
      }
    }

    if (shouldContinueReviewRun(setup)) {
      await runValidationRepair("validation_repair");
    }
  };

  const runPublishRecoveryPhase = async (attemptIndex: number) => {
    if (!shouldContinueReviewRun(setup)) return;
    recordReviewMetric({ kind: "phase_enter", phase: "publish_recovery" });
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
      await runValidationRepair("validation_repair");
    }
    if (isLastAttempt) {
      session.restoreTools();
    }
  };

  const runMaintainerPlaintextFallback = async () => {
    recordReviewMetric({ kind: "phase_enter", phase: "plaintext_fallback" });
    logWarn("agent_publish_fallback", {
      mode: reviewMode,
      publishAttempts,
      publishCallCount: setup.submitState.publishCallCount,
      maxPublishCalls: cfg.maxReviewPublishCalls,
    });
    const retryCommand = reviewRetrySlashCommandForMode(reviewMode);
    try {
      await upsertReviewSummaryComment(
        setup.getToken(),
        owner,
        repo,
        prNumber,
        renderReviewFailureNotice({ mode: reviewMode, retryCommand }),
        reviewSummarySentinelForMode(reviewMode),
      );
    } catch (e) {
      logWarn("review_publish_fallback_comment_failed", {
        mode: reviewMode,
        owner,
        repo,
        pr: prNumber,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  try {
    for (
      let attempt = 0;
      attempt < cfg.maxReviewPublishAttempts && shouldContinueReviewRun(setup);
      attempt++
    ) {
      publishAttempts = attempt + 1;
      if (attempt === 0) {
        await runInvestigationPhase();
      } else {
        await runPublishRecoveryPhase(attempt);
      }
    }

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
        await runMaintainerPlaintextFallback();
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
