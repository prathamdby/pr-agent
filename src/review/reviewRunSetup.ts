import type { Tool as PiTool } from "@earendil-works/pi-ai";
import type { Config } from "../config.js";
import type { LocalPrWorkspace } from "../prWorkspace/index.js";
import { createAskPathGate } from "../agent/askSafety.js";
import { buildContext7Tools } from "../agent/context7Tools.js";
import { buildGithubTools } from "../agent/githubTools.js";
import {
  buildLocalWorkspaceTools,
  workspaceToolLimitsFromConfig,
} from "../agent/localWorkspaceTools.js";
import { createRefreshableToolExecutors } from "../agent/providers/cursor/refreshableGithubTools.js";
import {
  createCachedPrDiffIndex,
  type CachedPrDiffIndex,
  wrapListPullRequestFilesDiffIngestion,
} from "./reviewDiffIndex.js";
import { automatedSecuritySystemPrompt } from "../agent/securityPrompt.js";
import { automatedQualitySystemPrompt } from "../agent/qualityPrompt.js";
import { buildAutomatedSystemPrompt } from "./reviewSystemPrompt.js";
import {
  buildSubmitReviewTool,
  createSubmitReviewState,
  type SubmitReviewState,
} from "./publish/submitReviewTool.js";
import type { ReviewMode } from "./reviewSchema.js";
import { buildReviewRunUserContent } from "./reviewUserMessage.js";

function systemPromptForReviewMode(reviewMode: ReviewMode): string {
  switch (reviewMode) {
    case "review-security":
      return automatedSecuritySystemPrompt;
    case "review-quality":
      return automatedQualitySystemPrompt;
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
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  reviewMode: ReviewMode;
  userSupplement?: string;
  trustedContext?: string;
  workspace?: LocalPrWorkspace;
  initialPublishState?: {
    published?: boolean;
    inlinePublished?: boolean;
    inlineReviewId?: number | null;
  };
  shouldLinkToSummary?: boolean;
  summaryCommentIdHint?: number | null;
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
    params.workspace?.diffIndex ?? createCachedPrDiffIndex();
  const submitState: SubmitReviewState = createSubmitReviewState({
    published: params.initialPublishState?.published,
    inlinePublished: params.initialPublishState?.inlinePublished,
    inlineReviewId: params.initialPublishState?.inlineReviewId,
  });

  const pathGate = createAskPathGate();
  const refreshableGh = createRefreshableToolExecutors({
    initialToken: token,
    tokenExpiresAtTs,
    refreshInstallationToken: params.refreshInstallationToken,
    githubToolNames: new Set([TOKEN_REFRESH_TOOL]),
    build: (activeToken) => {
      if (params.workspace) {
        return buildLocalWorkspaceTools(params.workspace, workspaceToolLimitsFromConfig(cfg), {
          pathGate,
        });
      }
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
      ctx: { owner, repo, prNumber, headSha },
      mode: reviewMode,
      state: submitState,
      cachedDiffIndex,
      shouldLinkToSummary: params.shouldLinkToSummary,
      summaryCommentIdHint: params.summaryCommentIdHint,
      recordPublishStep: params.recordPublishStep,
      shouldAbortPublish: params.shouldAbortPublish,
      storedInlineFingerprints: params.storedInlineFingerprints,
      publishAbortState: params.publishAbortState,
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
