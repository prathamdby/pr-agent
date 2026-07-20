import type { Tool as PiTool } from "@earendil-works/pi-ai";
import type { Config } from "../../config.js";
import type { LocalPrWorkspace } from "../../prWorkspace/index.js";
import { createAskPathGate } from "../../agent/ask/askSafety.js";
import { buildContext7Tools } from "../../agent/tools/context7Tools.js";
import {
  buildLocalWorkspaceTools,
} from "../../agent/tools/localWorkspaceTools.js";
import { createRefreshableToolExecutors } from "../../agent/tools/refreshableGithubTools.js";
import {
  createCachedPrDiffIndex,
  type CachedPrDiffIndex,
  wrapListPullRequestFilesDiffIngestion,
} from "../placement/reviewDiffIndex.js";
import { automatedSecuritySystemPrompt } from "../../agent/prompts/securityPrompt.js";
import { automatedQualitySystemPrompt } from "../../agent/prompts/qualityPrompt.js";
import { automatedReviewTestsSystemPrompt } from "../../agent/prompts/reviewTestsPrompt.js";
import { buildAutomatedSystemPrompt } from "../prompts/reviewSystemPrompt.js";
import {
  buildSubmitReviewTool,
  createSubmitReviewState,
  type SubmitReviewState,
} from "../publish/submitReviewTool.js";
import type { ReviewMode } from "../reviewSchema.js";
import { buildReviewRunUserContent } from "../prompts/reviewUserMessage.js";
import { CONTEXT7_RESPONSE_BYTES } from "../../settings/index.js";

function systemPromptForReviewMode(reviewMode: ReviewMode): string {
  switch (reviewMode) {
    case "review-security":
      return automatedSecuritySystemPrompt;
    case "review-quality":
      return automatedQualitySystemPrompt;
    case "review-tests":
      return automatedReviewTestsSystemPrompt;
    case "review":
      return buildAutomatedSystemPrompt();
  }
  const exhaustive: never = reviewMode;
  return exhaustive;
}

export type ReviewRunSetup = {
  readonly systemPrompt: string;
  readonly userContent: string;
  readonly piTools: PiTool[];
  readonly executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  readonly cachedDiffIndex: CachedPrDiffIndex;
  readonly submitState: SubmitReviewState;
  readonly getToken: () => string;
  readonly getTokenExpiresAtTs: () => number;
  readonly refreshBeforeTool: (toolName: string) => Promise<void>;
};

/** True while the harness should keep investigating or retrying publish. */
export function shouldContinueReviewRun(setup: Pick<ReviewRunSetup, "submitState">): boolean {
  return !setup.submitState.published && !setup.submitState.publishSuperseded;
}

const TOKEN_REFRESH_TOOL = "getPullRequest";

export function buildReviewRunSetup(params: {
  cfg: Config;
  token: string;
  tokenExpiresAtTs: number;
  tokenTtlMs: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  reviewMode: ReviewMode;
  userSupplement?: string;
  trustedContext?: string;
  workspace: LocalPrWorkspace;
  initialPublishState?: {
    published?: boolean;
    inlinePublished?: boolean;
    inlineReviewId?: number | null;
  };
  shouldLinkToSummary?: boolean;
  summaryCommentIdHint?: number | null;
  hasDescriptionAgentBlock?: boolean;
  recordPublishStep?: (
    step: "inline_review" | "summary_comment" | "labels",
    detail?: { githubId?: string | number; meta?: Record<string, unknown> },
  ) => Promise<void>;
  shouldAbortPublish?: () => Promise<boolean>;
  storedInlineFingerprints?: readonly string[];
  refreshInstallationToken?: () => Promise<{
    token: string;
    expiresAtTs: number;
  }>;
  publishAbortState?: { staleHead?: boolean };
  severityFloor?: number;
}): ReviewRunSetup {
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
    trustedContext,
  } = params;

  const cachedDiffIndex: CachedPrDiffIndex =
    params.workspace.diffIndex ?? createCachedPrDiffIndex();
  const submitState: SubmitReviewState = createSubmitReviewState({
    published: params.initialPublishState?.published,
    inlinePublished: params.initialPublishState?.inlinePublished,
    inlineReviewId: params.initialPublishState?.inlineReviewId,
  });

  const pathGate = createAskPathGate();
  const refreshableGh = createRefreshableToolExecutors({
    initialToken: token,
    tokenExpiresAtTs,
    tokenTtlMs: params.tokenTtlMs,
    refreshInstallationToken: params.refreshInstallationToken,
    githubToolNames: new Set([TOKEN_REFRESH_TOOL]),
    build: (_activeToken, _activeExpiresAtTs) => {
      const bundle = buildLocalWorkspaceTools(params.workspace, {
        pathGate,
      });
      const executors = { ...bundle.executors };
      wrapListPullRequestFilesDiffIngestion(executors, cachedDiffIndex);
      return { piTools: bundle.piTools, executors };
    },
  });

  const ctx7 = buildContext7Tools({
    apiKey: cfg.context7ApiKey,
    maxResponseBytes: CONTEXT7_RESPONSE_BYTES,
  });
  const buildSubmit = () =>
    buildSubmitReviewTool({
      cfg,
      token: refreshableGh.getToken(),
      getToken: () => refreshableGh.getToken(),
      tokenExpiresAtTs: refreshableGh.getTokenExpiresAtTs(),
      getTokenExpiresAtTs: () => refreshableGh.getTokenExpiresAtTs(),
      ctx: {
        owner,
        repo,
        prNumber,
        headSha,
        hasDescriptionAgentBlock: params.hasDescriptionAgentBlock ?? false,
      },
      mode: reviewMode,
      state: submitState,
      cachedDiffIndex,
      shouldLinkToSummary: params.shouldLinkToSummary,
      summaryCommentIdHint: params.summaryCommentIdHint,
      recordPublishStep: params.recordPublishStep,
      shouldAbortPublish: params.shouldAbortPublish,
      storedInlineFingerprints: params.storedInlineFingerprints,
      publishAbortState: params.publishAbortState,
      severityFloor: params.severityFloor,
    });

  let submitBundle = buildSubmit();
  const executors = { ...refreshableGh.bundle.executors, ...ctx7.executors };
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

  const refreshBeforeTool = async (toolName: string) => {
    if (refreshableGh.githubExecutorNames.has(toolName) || toolName === "submitReview") {
      await refreshableGh.refreshBeforeTool(TOKEN_REFRESH_TOOL);
      if (toolName === "submitReview") {
        submitBundle = buildSubmit();
      }
    }
  };

  return {
    systemPrompt: systemPromptForReviewMode(reviewMode),
    userContent: buildReviewRunUserContent({
      owner,
      repo,
      prNumber,
      headSha,
      reviewMode,
      userSupplement,
      trustedContext,
    }),
    piTools: [...refreshableGh.bundle.piTools, ...ctx7.piTools, submitBundle.piTool],
    executors,
    cachedDiffIndex,
    submitState,
    getToken: refreshableGh.getToken,
    getTokenExpiresAtTs: refreshableGh.getTokenExpiresAtTs,
    refreshBeforeTool,
  };
}

export function buildSubmitOnlyReviewSessionTools(setup: ReviewRunSetup): {
  piTools: PiTool[];
  executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
} {
  const submitTool = setup.piTools.find((tool) => tool.name === "submitReview");
  const submitReview = setup.executors.submitReview;
  if (!submitTool || !submitReview) {
    return { piTools: setup.piTools, executors: setup.executors };
  }
  return {
    piTools: [submitTool],
    executors: { submitReview },
  };
}
