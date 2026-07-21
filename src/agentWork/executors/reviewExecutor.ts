import { join } from "node:path";
import type { Pool } from "pg";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Config } from "../../config.js";
import { captureEvent } from "../../analytics/index.js";
import type { InstallationToken } from "../../github/appAuth.js";
import {
  assertPullRequestFilesHeadSha,
  fetchPullRequestFiles,
  type ListPullRequestFilesResult,
  type PullRequestForFileList,
} from "../../github/listPullRequestFiles.js";
import { runOrchestratedPrReview } from "../../review/orchestrator/orchestratorRun.js";
import type { ReviewRunResult } from "../../review/run/reviewRunTypes.js";
import { loadRepoPolicy, renderRepoPolicyBlock } from "../../review/repoPolicy.js";
import {
  loadAgentInstructionFiles,
  renderAgentInstructionFilesBlock,
} from "../../review/agentInstructionFiles.js";
import {
  buildTrustedReviewContextForReview,
  fetchPriorInlineFeedbackBlockForReview,
} from "../../review/prompts/reviewTrustedContext.js";
import { buildReviewPreflightMetadataFromPullRequestFiles } from "../../review/placement/reviewPreflightFiles.js";
import { reviewSummarySentinelForMode, type ReviewMode } from "../../review/reviewSchema.js";
import {
  initReviewRunMetrics,
  logReviewRunCompleted,
  recordReviewPhaseSpan,
  setReviewRunMetricFields,
  snapshotReviewRunMetrics,
} from "../../review/run/reviewRunMetrics.js";
import { upsertReviewSummaryComment } from "../../github/reviewPublish.js";
import { logInfo, logWarn } from "../../evlog.js";
import { attachSummaryCommentCoordination } from "../../review/publish/summaryCommentCoordination.js";
import { withPrRepositoryView } from "../../prWorkspace/index.js";
import type { PrRepositoryView } from "../../prWorkspace/prRepositoryView.js";
import {
  DESCRIPTION_AGENT_HEADER,
  MAX_REPO_POLICY_BYTES,
  MAX_AGENT_INSTRUCTION_BYTES,
  REPO_POLICY_DIRNAME,
  MAX_PR_FILES_LISTED,
  MAX_PR_FILES_PATCH_BYTES,
} from "../../settings/index.js";
import { tryLightweightAutoReviewCompletion } from "../reviewLightweightCompletion.js";
import {
  completeReviewCheckRun,
  ensureReviewCheckRunStarted,
  reviewCheckDetailsUrl,
} from "../reviewCheckRun.js";
import {
  loadReviewExecutorPublishContext,
  getSummaryCommentGithubId,
  recordPublishStep,
  shouldSkipWork,
  type ReviewExecutorPublishContext,
} from "../repository.js";
import {
  buildStaleSlashReviewRescheduleResult,
  type StaleSlashReviewRescheduleResult,
} from "../reviewReschedule.js";
import { renderReviewFailureNotice } from "../../review/run/progressComment.js";
import {
  makeInstallationTokenRefresher,
  resolveWorkItemHead,
  runDurableWorkItem,
} from "../durableJob.js";
import { getAppBotIdentity, getPullRequestHeadSha } from "../githubPrSurface.js";
import { type ReviewJobData, type ReviewWorkItem, type ReviewWorkPayload } from "../types.js";
import { buildRepositoryViewParams } from "./repositoryViewParams.js";
import { refreshInstallationTokenIfNearExpiry } from "../../review/orchestrator/refreshInstallationTokenIfNearExpiry.js";

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

type SettledPriorInlineFeedback = Result<string | undefined>;

async function tryCatchAsync<T>(
  fn: () => Promise<T>,
  onError?: (error: unknown) => void,
): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error: unknown) {
    onError?.(error);
    return { ok: false, error };
  }
}

/** Load a discriminated result and render the ok branch into a trusted-context block. */
async function loadAndRenderTrustedBlock<TResult extends { readonly kind: string }>(params: {
  readonly load: () => Promise<TResult>;
  readonly renderOk: (result: Extract<TResult, { kind: "ok" }>) => string;
  readonly onNonOk?: (result: Exclude<TResult, { kind: "ok" }>) => void;
}): Promise<string | undefined> {
  const result = await params.load();
  if (result.kind === "ok") {
    return params.renderOk(result as Extract<TResult, { kind: "ok" }>) || undefined;
  }
  params.onNonOk?.(result as Exclude<TResult, { kind: "ok" }>);
  return undefined;
}

type TokenState = { installation: InstallationToken };

type ReviewExecutionResult = StaleSlashReviewRescheduleResult | { readonly degraded: boolean };

type LightweightPhaseResult =
  | { readonly done: true; readonly result: ReviewExecutionResult }
  | { readonly done: false; readonly prefetchedPrFiles: ListPullRequestFilesResult | undefined };

async function handleStaleHeadReschedule(args: {
  readonly pool: Pool;
  readonly item: ReviewWorkItem;
  readonly reviewLens: ReviewMode;
  readonly payload: ReviewWorkPayload;
  readonly installation: InstallationToken;
}): Promise<StaleSlashReviewRescheduleResult | undefined> {
  const { pool, item, reviewLens, payload, installation } = args;
  if (
    payload.source !== "slash" ||
    payload.staleHeadRescheduled ||
    !payload.staleHeadReplacementWorkItemId
  ) {
    return undefined;
  }
  await completeReviewCheckRun(pool, {
    token: installation.token,
    tokenExpiresAtTs: installation.expiresAtTs,
    owner: item.owner,
    repo: item.repo,
    prNumber: item.prNumber,
    workItemId: item.id,
    resourceKey: item.resourceKey,
    reviewLens,
    conclusion: "cancelled",
    summary: "Review was rescheduled for a newer pull request head.",
  });
  return buildStaleSlashReviewRescheduleResult(
    pool,
    item,
    installation.token,
    installation.expiresAtTs,
  );
}

async function completeCheckFromStoredSummary(args: {
  readonly pool: Pool;
  readonly item: ReviewWorkItem;
  readonly reviewLens: ReviewMode;
  readonly tokenState: TokenState;
  readonly conclusion: "failure" | "cancelled";
  readonly summary: string;
}): Promise<void> {
  const { pool, item, reviewLens, tokenState, conclusion, summary } = args;
  const summaryCommentId = await getSummaryCommentGithubId(pool, item.resourceKey, reviewLens);
  await completeReviewCheckRun(pool, {
    token: tokenState.installation.token,
    tokenExpiresAtTs: tokenState.installation.expiresAtTs,
    owner: item.owner,
    repo: item.repo,
    prNumber: item.prNumber,
    workItemId: item.id,
    resourceKey: item.resourceKey,
    reviewLens,
    conclusion,
    summary,
    detailsUrl: reviewCheckDetailsUrl(item.owner, item.repo, item.prNumber, summaryCommentId),
  });
}

async function runLightweightCompletionOrSkip(args: {
  readonly cfg: Config;
  readonly pool: Pool;
  readonly item: ReviewWorkItem;
  readonly reviewLens: ReviewMode;
  readonly payload: ReviewWorkPayload;
  readonly tokenState: TokenState;
  readonly headSha: string;
}): Promise<LightweightPhaseResult> {
  const { cfg, pool, item, reviewLens, payload, tokenState, headSha } = args;
  if (payload.source !== "auto") {
    return { done: false, prefetchedPrFiles: undefined };
  }
  const prefetchedPrFiles = await recordReviewPhaseSpan("preflight", () =>
    fetchPullRequestFiles(
      tokenState.installation.token,
      item.owner,
      item.repo,
      item.prNumber,
      {
        maxPrFilesListed: MAX_PR_FILES_LISTED,
        maxPrFilesPatchBytes: MAX_PR_FILES_PATCH_BYTES,
      },
      undefined,
      tokenState.installation.expiresAtTs,
    ),
  );
  assertPullRequestFilesHeadSha(prefetchedPrFiles, headSha);
  const preflight = buildReviewPreflightMetadataFromPullRequestFiles(prefetchedPrFiles);
  const lightweightResult = await tryLightweightAutoReviewCompletion(pool, {
    item,
    reviewLens,
    token: tokenState.installation.token,
    tokenExpiresAtTs: tokenState.installation.expiresAtTs,
    preflight,
    model: cfg.piModel,
  });
  if (!lightweightResult.handled) {
    return { done: false, prefetchedPrFiles };
  }
  logInfo("review_lightweight_completion", {
    owner: item.owner,
    repo: item.repo,
    pr: item.prNumber,
    reviewLens,
    published: lightweightResult.published,
  });
  setReviewRunMetricFields({
    published: lightweightResult.published,
    publishAttempts: 0,
    lightweight: true,
  });
  logReviewRunCompleted();
  await completeReviewCheckRun(pool, {
    token: tokenState.installation.token,
    tokenExpiresAtTs: tokenState.installation.expiresAtTs,
    owner: item.owner,
    repo: item.repo,
    prNumber: item.prNumber,
    workItemId: item.id,
    resourceKey: item.resourceKey,
    reviewLens,
    conclusion: lightweightResult.published ? "success" : "cancelled",
    summary: lightweightResult.published
      ? "Documentation-only change set."
      : "Review was cancelled before lightweight completion.",
    detailsUrl: reviewCheckDetailsUrl(
      item.owner,
      item.repo,
      item.prNumber,
      lightweightResult.published ? lightweightResult.summaryId : null,
    ),
  });
  return { done: true, result: { degraded: false } };
}

function buildPriorInlineFeedbackPromise(args: {
  readonly cfg: Config;
  readonly item: ReviewWorkItem;
  readonly reviewLens: ReviewMode;
  readonly tokenState: TokenState;
}): Promise<SettledPriorInlineFeedback> {
  const { cfg, item, reviewLens, tokenState } = args;
  const logPriorFeedbackError = (error: unknown) => {
    logWarn("prior_inline_feedback_fetch_failed", {
      owner: item.owner,
      repo: item.repo,
      pr: item.prNumber,
      reviewLens,
      message: error instanceof Error ? error.message : String(error),
    });
  };
  return tryCatchAsync(async () => {
    const bot = await getAppBotIdentity(cfg);
    return fetchPriorInlineFeedbackBlockForReview({
      token: tokenState.installation.token,
      owner: item.owner,
      repo: item.repo,
      prNumber: item.prNumber,
      botUserId: bot.userId,
      onPriorFeedbackError: logPriorFeedbackError,
    });
  }, logPriorFeedbackError);
}

async function handleReviewPublishResult(args: {
  readonly cfg: Config;
  readonly pool: Pool;
  readonly item: ReviewWorkItem;
  readonly reviewLens: ReviewMode;
  readonly payload: ReviewWorkPayload;
  readonly tokenState: TokenState;
  readonly result: ReviewRunResult;
}): Promise<ReviewExecutionResult> {
  const { cfg, pool, item, reviewLens, payload, tokenState, result } = args;
  if (!result.published) {
    if (result.publishSuperseded) {
      logInfo("review_publish_superseded", {
        owner: item.owner,
        repo: item.repo,
        pr: item.prNumber,
        publishAttempts: result.publishAttempts,
      });
      await completeCheckFromStoredSummary({
        pool,
        item,
        reviewLens,
        tokenState,
        conclusion: "cancelled",
        summary: "Review publish was skipped because the work was superseded or cancelled.",
      });
    } else {
      logWarn("review_not_published", {
        owner: item.owner,
        repo: item.repo,
        pr: item.prNumber,
        publishAttempts: result.publishAttempts,
        publishDegraded: true,
      });
      captureEvent({
        distinctId: `installation:${item.installationId}`,
        event: "review failed",
        properties: {
          owner: item.owner,
          repo: item.repo,
          pr_number: item.prNumber,
          review_lens: reviewLens,
          publish_attempts: result.publishAttempts,
        },
      });
      await completeCheckFromStoredSummary({
        pool,
        item,
        reviewLens,
        tokenState,
        conclusion: "failure",
        summary: "PR Agent could not publish a structured review.",
      });
    }
  } else {
    const snapshot = snapshotReviewRunMetrics();
    captureEvent({
      distinctId: `installation:${item.installationId}`,
      event: "review published",
      properties: {
        owner: item.owner,
        repo: item.repo,
        pr_number: item.prNumber,
        review_lens: reviewLens,
        findings_count: snapshot?.findingsCount ?? 0,
        severities: snapshot?.severities ?? [],
        provider: cfg.agentProvider,
        model: cfg.piModel,
        publish_attempts: result.publishAttempts,
        wall_clock_ms: snapshot?.wallClockMs,
        source: payload.source,
      },
    });
  }
  return { degraded: !result.published && !result.publishSuperseded };
}

async function runFullReviewAgainstRepositoryView(args: {
  readonly cfg: Config;
  readonly pool: Pool;
  readonly item: ReviewWorkItem;
  readonly reviewLens: ReviewMode;
  readonly payload: ReviewWorkPayload;
  readonly tokenState: TokenState;
  readonly headSha: string;
  readonly pullRequest: PullRequestForFileList | undefined;
  readonly publishContext: ReviewExecutorPublishContext;
  readonly publishAbortState: { staleHead?: boolean };
  readonly staleHeadAtPublish: { value: boolean };
  readonly priorInlineFeedback: Promise<SettledPriorInlineFeedback>;
  readonly repositoryView: PrRepositoryView;
}): Promise<ReviewExecutionResult> {
  const {
    cfg,
    pool,
    item,
    reviewLens,
    payload,
    tokenState,
    headSha,
    pullRequest,
    publishContext,
    publishAbortState,
    staleHeadAtPublish,
    priorInlineFeedback,
    repositoryView,
  } = args;
  const {
    publishState,
    shouldLinkToSummary,
    storedInlineFingerprints,
    summaryCommentGithubId: summaryCommentIdHint,
  } = publishContext;

  const priorInlineFeedbackResult = await priorInlineFeedback;
  if (!priorInlineFeedbackResult.ok) throw priorInlineFeedbackResult.error;

  const changedFiles = (repositoryView.preflight.files ?? []).map((file) => file.filename);
  const [repoPolicyBlock, agentInstructionFilesBlock] = await Promise.all([
    loadAndRenderTrustedBlock({
      load: () => loadRepoPolicy(repositoryView.agentCwd, MAX_REPO_POLICY_BYTES),
      renderOk: (result) =>
        renderRepoPolicyBlock({
          policy: result.policy,
          changedFiles,
        }),
      onNonOk: (result) => {
        if (result.kind === "invalid") {
          logWarn("repo_policy_invalid", {
            path: join(repositoryView.agentCwd, REPO_POLICY_DIRNAME),
            reason: result.reason,
          });
        }
      },
    }),
    loadAndRenderTrustedBlock({
      load: () => loadAgentInstructionFiles(repositoryView.agentCwd, MAX_AGENT_INSTRUCTION_BYTES),
      renderOk: (result) => renderAgentInstructionFilesBlock({ files: result.files }),
    }),
  ]);

  const trustedContext = buildTrustedReviewContextForReview({
    preflight: repositoryView.preflight,
    priorInlineFeedback: priorInlineFeedbackResult.value,
    repoPolicyBlock,
    agentInstructionFilesBlock,
  });

  const refreshInstallationToken = makeInstallationTokenRefresher(
    cfg,
    item.installationId,
    tokenState,
  );

  const result = await runOrchestratedPrReview({
    cfg,
    token: tokenState.installation.token,
    tokenExpiresAtTs: tokenState.installation.expiresAtTs,
    tokenTtlMs: tokenState.installation.ttlMs,
    owner: item.owner,
    repo: item.repo,
    prNumber: item.prNumber,
    headSha,
    mode: reviewLens,
    userSupplement: payload.userSupplement,
    trustedContext,
    storedInlineFingerprints,
    cwd: repositoryView.agentCwd,
    workspace: repositoryView.workspace,
    shouldLinkToSummary,
    summaryCommentIdHint,
    hasDescriptionAgentBlock: (pullRequest?.body ?? "").includes(DESCRIPTION_AGENT_HEADER),
    prTitle: pullRequest?.title ?? "",
    prBody: pullRequest?.body ?? "",
    progressTick: {
      pool,
      workItemId: item.id,
      resourceKey: item.resourceKey,
    },
    initialPublishState: {
      published: publishState.summaryPublished,
      inlineReviewIds: publishState.inlineReviewIds,
      postedInlineCount: publishState.postedInlineCount,
      batchCount: publishState.batchCount,
    },
    recordPublishStep: attachSummaryCommentCoordination(
      (step, detail) =>
        recordPublishStep(pool, {
          workItemId: item.id,
          resourceKey: item.resourceKey,
          reviewLens,
          step,
          githubId: detail?.githubId,
          detail: detail?.meta,
        }),
      { pool, workItemId: item.id, resourceKey: item.resourceKey },
    ),
    reviewSource: payload.source,
    staleHeadRescheduled: payload.staleHeadRescheduled,
    publishAbortState,
    shouldCancelRun: async () => shouldSkipWork(pool, item),
    shouldAbortPublish: async () => {
      if (await shouldSkipWork(pool, item)) return true;
      await refreshInstallationTokenIfNearExpiry({
        getTokenExpiresAtTs: () => tokenState.installation.expiresAtTs,
        refreshInstallationToken,
      });
      const latestHeadSha = await getPullRequestHeadSha(
        tokenState.installation.token,
        item.owner,
        item.repo,
        item.prNumber,
        tokenState.installation.expiresAtTs,
      );
      if (latestHeadSha !== headSha) {
        staleHeadAtPublish.value = true;
        publishAbortState.staleHead = true;
        return true;
      }
      return false;
    },
    refreshInstallationToken,
  });

  if (staleHeadAtPublish.value && payload.source === "slash" && !payload.staleHeadRescheduled) {
    await completeCheckFromStoredSummary({
      pool,
      item,
      reviewLens,
      tokenState,
      conclusion: "cancelled",
      summary: "Review was rescheduled for a newer pull request head.",
    });
    return buildStaleSlashReviewRescheduleResult(
      pool,
      item,
      tokenState.installation.token,
      tokenState.installation.expiresAtTs,
    );
  }

  return handleReviewPublishResult({
    cfg,
    pool,
    item,
    reviewLens,
    payload,
    tokenState,
    result,
  });
}

export async function executeReviewJob(
  cfg: Config,
  pool: Pool,
  boss: PgBoss,
  job: JobWithMetadata<ReviewJobData>,
): Promise<void> {
  await runDurableWorkItem({
    cfg,
    pool,
    boss,
    job,
    type: "review",
    acceptItem: (item) => item.reviewLens != null,
    resolveHeadSha: resolveWorkItemHead,
    execute: async (item, env) => {
      const reviewLens = item.reviewLens;
      const payload = item.payload;
      initReviewRunMetrics({
        provider: cfg.agentProvider,
        model: cfg.piModel,
        mode: reviewLens,
      });

      const staleHeadResult = await handleStaleHeadReschedule({
        pool,
        item,
        reviewLens,
        payload,
        installation: env.installation,
      });
      if (staleHeadResult) return staleHeadResult;

      const publishContext = await recordReviewPhaseSpan("db-read", () =>
        loadReviewExecutorPublishContext(pool, item.id, item.resourceKey, reviewLens),
      );
      const tokenState: TokenState = { installation: env.installation };
      const headSha = env.headSha;
      const staleHeadAtPublish = { value: false };
      const publishAbortState: { staleHead?: boolean } = {};

      await ensureReviewCheckRunStarted(pool, {
        token: tokenState.installation.token,
        tokenExpiresAtTs: tokenState.installation.expiresAtTs,
        owner: item.owner,
        repo: item.repo,
        prNumber: item.prNumber,
        headSha,
        workItemId: item.id,
        resourceKey: item.resourceKey,
        reviewLens,
      });

      const lightweight = await runLightweightCompletionOrSkip({
        cfg,
        pool,
        item,
        reviewLens,
        payload,
        tokenState,
        headSha,
      });
      if (lightweight.done) return lightweight.result;

      const priorInlineFeedback = buildPriorInlineFeedbackPromise({
        cfg,
        item,
        reviewLens,
        tokenState,
      });

      return withPrRepositoryView(
        buildRepositoryViewParams(
          item,
          { installation: tokenState.installation, headSha, pullRequest: env.pullRequest },
          payload,
          { prFiles: lightweight.prefetchedPrFiles },
        ),
        async (repositoryView) =>
          runFullReviewAgainstRepositoryView({
            cfg,
            pool,
            item,
            reviewLens,
            payload,
            tokenState,
            headSha,
            pullRequest: env.pullRequest,
            publishContext,
            publishAbortState,
            staleHeadAtPublish,
            priorInlineFeedback,
            repositoryView,
          }),
      );
    },
    onCancelled: async (item, installation) => {
      if (!item.reviewLens) return;
      const reviewLens = item.reviewLens;
      const summaryCommentId = await getSummaryCommentGithubId(pool, item.resourceKey, reviewLens);
      await completeReviewCheckRun(pool, {
        token: installation.token,
        tokenExpiresAtTs: installation.expiresAtTs,
        owner: item.owner,
        repo: item.repo,
        prNumber: item.prNumber,
        workItemId: item.id,
        resourceKey: item.resourceKey,
        reviewLens,
        conclusion: "cancelled",
        summary: "Review was cancelled before completion.",
        detailsUrl: reviewCheckDetailsUrl(item.owner, item.repo, item.prNumber, summaryCommentId),
      });
    },
    onTerminalFailure: async (item, installation) => {
      if (!installation) return;
      const reviewLens = item.reviewLens;
      const summary = await upsertReviewSummaryComment(
        installation.token,
        item.owner,
        item.repo,
        item.prNumber,
        renderReviewFailureNotice({
          mode: reviewLens,
          retryCommand: "/review",
        }),
        reviewSummarySentinelForMode(reviewLens),
        undefined,
        installation.expiresAtTs,
      );
      await completeReviewCheckRun(pool, {
        token: installation.token,
        tokenExpiresAtTs: installation.expiresAtTs,
        owner: item.owner,
        repo: item.repo,
        prNumber: item.prNumber,
        workItemId: item.id,
        resourceKey: item.resourceKey,
        reviewLens,
        conclusion: "failure",
        summary: "PR Agent could not complete the review after retries.",
        detailsUrl: reviewCheckDetailsUrl(item.owner, item.repo, item.prNumber, summary.id),
      });
    },
  });
}
