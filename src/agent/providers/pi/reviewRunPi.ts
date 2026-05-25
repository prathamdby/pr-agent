import type { AssistantMessage, Tool as PiTool } from "@earendil-works/pi-ai";
import type { Config } from "../../../config.js";
import { logInfo, logWarn } from "../../../evlog.js";
import { upsertReviewSummaryComment } from "../../../github/reviewPublish.js";
import { renderReviewFailureNotice } from "../../../agentWork/progressComment.js";
import { buildContext7Tools } from "../../context7Tools.js";
import { buildGithubTools } from "../../githubTools.js";
import { buildLocalWorkspaceTools } from "../../localWorkspaceTools.js";
import {
  createCachedPrDiffIndex,
  type CachedPrDiffIndex,
  wrapListPullRequestFilesDiffIngestion,
} from "../../reviewDiffPlacement.js";
import { automatedSecuritySystemPrompt } from "../../securityPrompt.js";
import { buildAutomatedSystemPrompt } from "../../reviewSystemPrompt.js";
import {
  buildSubmitReviewTool,
  createSubmitReviewState,
  type SubmitReviewState,
} from "../../submitReviewTool.js";
import { PRE_SUBMIT_USER_MESSAGE } from "../../reviewPromptBlocks.js";
import { PUBLISH_RECOVERY_PROMPTS, PROSE_ONLY_NUDGE } from "../../../settings/index.js";
import { reviewSummarySentinelForMode, type ReviewMode } from "../../reviewSchema.js";
import { buildReviewRunUserContent } from "../../reviewUserMessage.js";
import type { ReviewRunResult } from "../../reviewRun.js";
import {
  initReviewRunMetrics,
  logReviewRunCompleted,
  recordReviewMetric,
  setReviewRunMetricFields,
} from "../../reviewRunMetrics.js";
import { piAgentRunnerProvider } from "./index.js";

function assistantFromText(cfg: Config, text: string): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: cfg.piProvider as never,
    provider: cfg.piProvider,
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

export async function runPiCodingFullPrReview(params: {
  cfg: Config;
  token: string;
  tokenExpiresAtTs: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  reviewMode: ReviewMode;
  userSupplement?: string;
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
  refreshInstallationToken?: () => Promise<{ token: string; expiresAtTs: number }>;
  trustedContext?: string;
  storedInlineFingerprints?: readonly string[];
  cwd?: string;
  workspace?: import("../../../agentWork/localPrWorkspace.js").LocalPrWorkspace;
}): Promise<ReviewRunResult> {
  const { cfg, owner, repo, prNumber, headSha, reviewMode, userSupplement, trustedContext } =
    params;
  initReviewRunMetrics({ provider: "pi", model: cfg.piModel, mode: reviewMode });

  const repoTools = params.workspace
    ? buildLocalWorkspaceTools(params.workspace)
    : buildGithubTools(params.token, {
        maxPrFilesListed: cfg.maxPrFilesListed,
        maxPrFilesPatchBytes: cfg.maxPrFilesPatchBytes,
      });
  const ctx7 = buildContext7Tools({ apiKey: cfg.context7ApiKey });
  const cachedDiffIndex: CachedPrDiffIndex = createCachedPrDiffIndex();
  const submitState: SubmitReviewState = createSubmitReviewState({
    published: params.initialPublishState?.published,
    inlinePublished: params.initialPublishState?.inlinePublished,
    inlineReviewId: params.initialPublishState?.inlineReviewId,
  });
  const repoExecutors = { ...repoTools.executors };
  if (!params.workspace) wrapListPullRequestFilesDiffIngestion(repoExecutors, cachedDiffIndex);
  if (params.workspace) {
    cachedDiffIndex.truncated = params.workspace.diffIndex.truncated;
    cachedDiffIndex.listPullRequestFilesIngested = true;
    for (const [path, file] of params.workspace.diffIndex.files.entries()) {
      cachedDiffIndex.files.set(path, file);
    }
  }
  const { piTool: submitTool, executor: submitExecutor } = buildSubmitReviewTool({
    cfg,
    token: params.token,
    ctx: { owner, repo, prNumber, headSha },
    mode: reviewMode,
    state: submitState,
    cachedDiffIndex,
    shouldLinkToSummary: params.shouldLinkToSummary,
    summaryCommentIdHint: params.summaryCommentIdHint,
    recordPublishStep: params.recordPublishStep,
    shouldAbortPublish: params.shouldAbortPublish,
    storedInlineFingerprints: params.storedInlineFingerprints,
  });
  const tools: PiTool[] = [...repoTools.piTools, ...ctx7.piTools, submitTool];
  const executors = { ...repoExecutors, ...ctx7.executors, submitReview: submitExecutor };
  const session = await piAgentRunnerProvider.createSession({
    cfg,
    cwd: params.cwd,
    systemPrompt:
      reviewMode === "review-security"
        ? automatedSecuritySystemPrompt
        : buildAutomatedSystemPrompt(),
    tools,
    executors,
  });
  let lastText = "";
  try {
    const userContent = buildReviewRunUserContent({
      owner,
      repo,
      prNumber,
      headSha,
      reviewMode,
      userSupplement,
      trustedContext,
    });
    lastText = (await session.send(userContent)).text;
    if (!submitState.published) {
      recordReviewMetric({ kind: "prose_only", phase: "pre_submit" });
      lastText = (await session.send([PROSE_ONLY_NUDGE, PRE_SUBMIT_USER_MESSAGE].join("\n\n")))
        .text;
    }
    for (const prompt of PUBLISH_RECOVERY_PROMPTS) {
      if (submitState.published) break;
      recordReviewMetric({ kind: "phase_enter", phase: "publish_recovery" });
      lastText = (await session.send(prompt)).text;
    }
    if (!submitState.published) {
      logWarn("review_publish_exhausted", {
        owner,
        repo,
        pr: prNumber,
        attempts: 1,
        publishCallCount: submitState.publishCallCount,
      });
      await upsertReviewSummaryComment(
        params.token,
        owner,
        repo,
        prNumber,
        renderReviewFailureNotice({
          mode: reviewMode,
          retryCommand: reviewMode === "review-security" ? "/review-security" : "/review",
        }),
        reviewSummarySentinelForMode(reviewMode),
      ).catch((e) => {
        logWarn("review_publish_fallback_comment_failed", {
          owner,
          repo,
          pr: prNumber,
          message: e instanceof Error ? e.message : String(e),
        });
      });
    }
  } finally {
    await session.dispose();
  }
  setReviewRunMetricFields({ published: submitState.published, publishAttempts: 1 });
  logReviewRunCompleted();
  logInfo("pi_coding_review_completed", {
    owner,
    repo,
    pr: prNumber,
    published: submitState.published,
  });
  return {
    lastAssistant: assistantFromText(cfg, lastText),
    published: submitState.published,
    publishAttempts: 1,
  };
}
