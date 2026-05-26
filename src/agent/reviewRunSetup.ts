import type { Tool as PiTool } from "@earendil-works/pi-ai";
import type { Config } from "../config.js";
import type { LocalPrWorkspace } from "../agentWork/localPrWorkspace.js";
import { buildContext7Tools } from "./context7Tools.js";
import { buildGithubTools } from "./githubTools.js";
import { buildLocalWorkspaceTools } from "./localWorkspaceTools.js";
import { createRefreshableToolExecutors } from "./providers/cursor/refreshableGithubTools.js";
import {
  createCachedPrDiffIndex,
  type CachedPrDiffIndex,
  wrapListPullRequestFilesDiffIngestion,
} from "./reviewDiffPlacement.js";
import { automatedSecuritySystemPrompt } from "./securityPrompt.js";
import { buildAutomatedSystemPrompt } from "./reviewSystemPrompt.js";
import {
  buildSubmitReviewTool,
  createSubmitReviewState,
  type SubmitReviewState,
} from "./submitReviewTool.js";
import type { ReviewMode } from "./reviewSchema.js";
import { buildReviewRunUserContent } from "./reviewUserMessage.js";

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
  refreshInstallationToken?: () => Promise<{ token: string; expiresAtTs: number }>;
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

  let cachedDiffIndex: CachedPrDiffIndex = createCachedPrDiffIndex();
  const submitState: SubmitReviewState = createSubmitReviewState({
    published: params.initialPublishState?.published,
    inlinePublished: params.initialPublishState?.inlinePublished,
    inlineReviewId: params.initialPublishState?.inlineReviewId,
  });

  const refreshableGh = params.workspace
    ? {
        bundle: buildLocalWorkspaceTools(params.workspace),
        githubExecutorNames: new Set<string>(),
        refreshBeforeTool: async () => undefined,
        getToken: () => token,
      }
    : createRefreshableToolExecutors({
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

  if (params.workspace) {
    cachedDiffIndex.truncated = params.workspace.diffIndex.truncated;
    cachedDiffIndex.listPullRequestFilesIngested = true;
    for (const [path, file] of params.workspace.diffIndex.files.entries()) {
      cachedDiffIndex.files.set(path, file);
    }
  }

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
      await refreshableGh.refreshBeforeTool("getPullRequest");
      if (toolName === "submitReview") {
        submitBundle = buildSubmit();
      }
    }
  };

  return {
    systemPrompt:
      reviewMode === "review-security"
        ? automatedSecuritySystemPrompt
        : buildAutomatedSystemPrompt(),
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
