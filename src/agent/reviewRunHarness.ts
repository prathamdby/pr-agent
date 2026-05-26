import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Config } from "../config.js";
import type { LocalPrWorkspace } from "../agentWork/localPrWorkspace.js";
import type { WorkSource } from "../agentWork/types.js";
import { logInfo, logWarn } from "../evlog.js";
import { upsertReviewSummaryComment } from "../github/reviewPublish.js";
import { renderReviewFailureNotice } from "../agentWork/progressComment.js";
import { resolveAgentRunnerProvider } from "./providers/index.js";
import { renderAnchorMenuBlock } from "./reviewDiffPlacement.js";
import { PRE_SUBMIT_USER_MESSAGE } from "./reviewPromptBlocks.js";
import {
  PROSE_ONLY_NUDGE,
  PUBLISH_RECOVERY_PROMPTS,
  PUBLISH_RECOVERY_ROUNDS,
  VALIDATION_REPAIR_ROUNDS,
  type ReviewPhase,
} from "../settings/index.js";
import {
  REVIEW_PAYLOAD_MINIMAL_EXAMPLE,
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
import { buildReviewRunSetup, buildSubmitOnlyReviewSessionTools } from "./reviewRunSetup.js";

function assistantFromText(cfg: Config, text: string, provider: string): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: provider === "cursor" ? ("cursor-sdk" as never) : (cfg.piProvider as never),
    provider: provider === "cursor" ? "cursor" : cfg.piProvider,
    model: cfg.piModel,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

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

  const runValidationRepair = async (phase: ReviewPhase) => {
    recordReviewMetric({ kind: "phase_enter", phase });
    for (
      let repair = 0;
      repair < VALIDATION_REPAIR_ROUNDS && !setup.submitState.published;
      repair++
    ) {
      const validationError = setup.submitState.lastValidationError;
      if (!validationError) break;
      setup.submitState.lastValidationError = null;
      lastText = (
        await session.send(
          [
            validationError,
            "Fix the payload and call submitReview again with a complete ReviewPayload.",
            `Minimal valid example:\n${JSON.stringify(REVIEW_PAYLOAD_MINIMAL_EXAMPLE, null, 2)}`,
          ].join("\n\n"),
        )
      ).text;
    }
  };

  const runInvestigationPhase = async () => {
    recordReviewMetric({ kind: "phase_enter", phase: "investigation" });
    lastText = (await session.send(setup.userContent)).text;

    if (
      cfg.reviewInjectAnchorMenu &&
      setup.cachedDiffIndex.files.size > 0 &&
      !setup.submitState.published
    ) {
      const anchorMenu = renderAnchorMenuBlock(setup.cachedDiffIndex, {
        maxFiles: cfg.reviewAnchorMenuMaxFiles,
        maxRangesPerFile: cfg.reviewAnchorMenuMaxRangesPerFile,
      });
      if (anchorMenu) {
        lastText = (await session.send(anchorMenu)).text;
      }
    }

    if (!setup.submitState.published) {
      recordReviewMetric({ kind: "prose_only", phase: "pre_submit" });
      lastText = (await session.send([PROSE_ONLY_NUDGE, PRE_SUBMIT_USER_MESSAGE].join("\n\n")))
        .text;
    }

    await runValidationRepair("validation_repair");
  };

  const runPublishRecoveryPhase = async (attemptIndex: number) => {
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
    for (let round = 0; round < PUBLISH_RECOVERY_ROUNDS && !setup.submitState.published; round++) {
      lastText = (
        await session.send(
          [
            prompt,
            `Minimal valid ReviewPayload example:\n${JSON.stringify(REVIEW_PAYLOAD_MINIMAL_EXAMPLE, null, 2)}`,
          ].join("\n\n"),
        )
      ).text;
    }
    await runValidationRepair("validation_repair");
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
    const retryCommand = reviewMode === "review-security" ? "/review-security" : "/review";
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
      attempt < cfg.maxReviewPublishAttempts && !setup.submitState.published;
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
      if (!willRescheduleStaleHead) {
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
  };
}
