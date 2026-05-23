import type { Config } from "../../config.js";
import { logInfo, logWarn } from "../../evlog.js";
import { upsertReviewSummaryComment } from "../../github/reviewPublish.js";
import { renderReviewFailureNotice } from "../../agentWork/progressComment.js";
import { complete } from "@earendil-works/pi-ai";
import type { AssistantMessage, Context, Tool as PiTool } from "@earendil-works/pi-ai";
import { buildContext7Tools } from "../context7Tools.js";
import { buildGithubTools } from "../githubTools.js";
import {
  createCachedPrDiffIndex,
  type CachedPrDiffIndex,
  wrapListPullRequestFilesDiffIngestion,
} from "../reviewLocationValidation.js";
import { automatedSecuritySystemPrompt } from "../securityPrompt.js";
import { buildAutomatedSystemPrompt } from "../reviewSystemPrompt.js";
import {
  buildSubmitReviewTool,
  createSubmitReviewState,
  type SubmitReviewState,
} from "../submitReviewTool.js";
import { reviewSummarySentinelForMode, type ReviewMode } from "../reviewSchema.js";
import type { ReviewRunResult } from "../reviewRun.js";
import { attachCursorRunContext, getCursorModel } from "./index.js";
import { createRefreshableToolExecutors } from "./refreshableGithubTools.js";

export async function runCursorFullPrReview(params: {
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
  inlineReviewIdHint?: number | null;
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
}): Promise<ReviewRunResult> {
  const {
    cfg,
    token,
    tokenExpiresAtTs,
    owner,
    repo,
    prNumber,
    headSha,
    reviewMode,
    userSupplement,
  } = params;

  if (!Number.isFinite(tokenExpiresAtTs)) {
    throw new Error("tokenExpiresAtTs must be a finite timestamp in milliseconds");
  }

  let cachedDiffIndex: CachedPrDiffIndex = createCachedPrDiffIndex();
  const submitState: SubmitReviewState = createSubmitReviewState({
    published: params.initialPublishState?.published,
    inlinePublished: params.initialPublishState?.inlinePublished,
    inlineReviewId: params.initialPublishState?.inlineReviewId,
  });
  const publishCtx = { owner, repo, prNumber, headSha };

  const refreshableGh = createRefreshableToolExecutors({
    initialToken: token,
    tokenExpiresAtTs,
    refreshInstallationToken: params.refreshInstallationToken,
    build: (activeToken) => {
      const gh = buildGithubTools(activeToken, {
        maxPrFilesListed: cfg.maxPrFilesListed,
        maxPrFilesPatchBytes: cfg.maxPrFilesPatchBytes,
      });
      const executors = { ...gh.executors };
      wrapListPullRequestFilesDiffIngestion(executors, cachedDiffIndex);
      return { piTools: gh.piTools, executors };
    },
  });

  const ctx7 = buildContext7Tools({ apiKey: cfg.context7ApiKey });

  const buildSubmit = () =>
    buildSubmitReviewTool({
      cfg,
      token: refreshableGh.getToken(),
      getToken: () => refreshableGh.getToken(),
      ctx: publishCtx,
      mode: reviewMode,
      state: submitState,
      cachedDiffIndex,
      shouldLinkToSummary: params.shouldLinkToSummary,
      summaryCommentIdHint: params.summaryCommentIdHint,
      inlineReviewIdHint: params.inlineReviewIdHint,
      recordPublishStep: params.recordPublishStep,
      shouldAbortPublish: params.shouldAbortPublish,
    });

  let submitBundle = buildSubmit();
  const executors = refreshableGh.bundle.executors;
  Object.assign(executors, ctx7.executors);
  executors.submitReview = async (args) => {
    if (submitState.published) {
      return {
        ok: true,
        alreadyPublished: true,
        message: "Stop further investigation; the review has been published.",
      };
    }
    return submitBundle.executor(args);
  };

  const piTools: PiTool[] = [
    ...refreshableGh.bundle.piTools,
    ...ctx7.piTools,
    submitBundle.piTool,
  ];
  const model = getCursorModel(cfg.piModel);

  const userContent = [
    `Target repository: ${owner}/${repo}`,
    `Pull request #: ${prNumber}`,
    `Head commit SHA: ${headSha}`,
    userSupplement ? `\nAdditional instruction:\n${userSupplement}\n` : "",
    "",
    reviewMode === "review-security"
      ? "Perform a deep security review of the PR diff using investigation tools, then call submitReview exactly once with a complete ReviewPayload."
      : "Perform a full review using investigation tools, then call submitReview exactly once with a complete ReviewPayload.",
  ].join("\n");

  const context: Context = {
    systemPrompt:
      reviewMode === "review-security"
        ? automatedSecuritySystemPrompt
        : buildAutomatedSystemPrompt(),
    messages: [
      {
        role: "user",
        content: userContent,
        timestamp: Date.now(),
      },
    ],
    tools: piTools,
  };

  attachCursorRunContext(context, {
    executors,
    apiKey: cfg.cursorApiKey,
    refreshBeforeTool: async (toolName) => {
      if (refreshableGh.githubExecutorNames.has(toolName) || toolName === "submitReview") {
        await refreshableGh.refreshBeforeTool("getPullRequest");
        if (toolName === "submitReview") {
          submitBundle = buildSubmit();
        }
      }
    },
  });

  logInfo("cursor_review_started", { owner, repo, pr: prNumber, mode: reviewMode, model: model.id });

  const lastAssistant = await complete(model, context, { apiKey: cfg.cursorApiKey });

  if (!submitState.published) {
    logWarn("cursor_review_not_published", {
      mode: reviewMode,
      owner,
      repo,
      pr: prNumber,
      stopReason: lastAssistant.stopReason,
      errorMessage: lastAssistant.errorMessage,
    });
    const retryCommand = reviewMode === "review-security" ? "/review-security" : "/review";
    const body = renderReviewFailureNotice({ mode: reviewMode, retryCommand });
    try {
      await upsertReviewSummaryComment(
        refreshableGh.getToken(),
        owner,
        repo,
        prNumber,
        body,
        reviewSummarySentinelForMode(reviewMode),
      );
    } catch (e) {
      logWarn("cursor_review_failure_notice_failed", {
        owner,
        repo,
        pr: prNumber,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { lastAssistant, published: submitState.published, publishAttempts: 1 };
}
