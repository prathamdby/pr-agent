import type { Config } from "../../config.js";
import { AppError } from "../../errors/appError.js";
import { logDebug, logWarn } from "../../evlog.js";
import {
  listPullRequestLabels,
  listPullRequestReviewCommentsForReview,
  resolveVerifiedSummaryCommentRef,
  setPullRequestLabels,
  setReviewCommitStatus,
  upsertReviewSummaryComment,
} from "../../github/reviewPublish.js";
import {
  completeReviewCheckRun,
  reviewCheckDetailsUrl,
  reviewCheckRunOutcome,
} from "../../agentWork/reviewCheckRun.js";
import {
  REVIEW_CI_SUMMARY_MAX_FAILURES,
  REVIEW_CI_SUMMARY_WAIT_MS,
  REVIEW_CI_SUMMARY_WAIT_POLL_MS,
} from "../../settings/index.js";
import { buildCiSummary } from "../ci/analyzeCi.js";
import type { CiSummaryAuthor } from "../ci/authorCiSummary.js";
import {
  dominantReviewCategory,
  hasManagedCategoryLabel,
  labelsAlreadySynced,
  reviewLabelsFromPayload,
  syncReviewLabels,
} from "../run/reviewLabels.js";
import { renderReviewSummaryComment } from "../run/reviewRender.js";
import { snapshotReviewRunMetrics } from "../run/reviewRunMetrics.js";
import type { InlinePlacement } from "../placement/reviewDiffPlacement.js";
import type { CachedPrDiffIndex } from "../placement/reviewDiffIndex.js";
import {
  reviewSummarySentinelForMode,
  type ReviewPayload,
  type ReviewPublishContext,
} from "../reviewSchema.js";
import { enrichPlacementsWithInlineCommentUrls } from "./placementEnrichment.js";
import {
  type RecordPublishStepWithCoordination,
  upsertSummaryCommentWithCreationClaim,
} from "./summaryCommentCoordination.js";

export type PublishReviewSummaryOnlyArgs = {
  cfg: Pick<Config, "piModel" | "features">;
  ctx: ReviewPublishContext;
  getToken: () => string;
  getTokenExpiresAtTs?: () => number | undefined;
  payload: ReviewPayload;
  summaryPlacements: readonly InlinePlacement[];
  inlineReviewIds: readonly number[];
  recordPublishStep: RecordPublishStepWithCoordination;
  ciAuthor?: CiSummaryAuthor;
  partialCoverageNote?: string;
  cachedDiffIndex?: CachedPrDiffIndex;
  shouldLinkToSummary?: boolean;
  summaryCommentIdHint?: number | null;
  knownSummaryCommentRef?: { id: number; url: string } | null;
  staleReview?: boolean;
  shouldAbortPublish?: () => Promise<boolean>;
  publishAbortState?: { staleHead?: boolean };
  publishMeta?: Record<string, unknown>;
};

async function assertSummaryPublishAllowed(args: PublishReviewSummaryOnlyArgs): Promise<void> {
  if (!args.shouldAbortPublish) return;
  let abort = false;
  try {
    abort = await args.shouldAbortPublish();
  } catch (error) {
    logWarn("review_summary_abort_check_failed", {
      owner: args.ctx.owner,
      repo: args.ctx.repo,
      pr: args.ctx.prNumber,
      message: error instanceof Error ? error.message : String(error),
    });
    abort = true;
  }
  if (!abort) return;
  throw new AppError({
    code: "review.publish_superseded",
    message: "Review summary publish skipped: work superseded or cancelled",
    context: {
      reason: args.publishAbortState?.staleHead === true ? "stale_head" : "superseded",
    },
  });
}

async function enrichFromReviewIds(args: PublishReviewSummaryOnlyArgs): Promise<InlinePlacement[]> {
  let placements = [...args.summaryPlacements];
  for (const reviewId of new Set(args.inlineReviewIds)) {
    try {
      const comments = await listPullRequestReviewCommentsForReview(
        args.getToken(),
        args.ctx.owner,
        args.ctx.repo,
        args.ctx.prNumber,
        reviewId,
        args.getTokenExpiresAtTs?.(),
      );
      placements = enrichPlacementsWithInlineCommentUrls(placements, comments);
    } catch (error) {
      logWarn("review_inline_comment_urls_failed", {
        mode: "review",
        owner: args.ctx.owner,
        repo: args.ctx.repo,
        pr: args.ctx.prNumber,
        reviewId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return placements;
}

async function syncLabels(
  args: PublishReviewSummaryOnlyArgs,
  currentLabels: string[] | unknown,
): Promise<void> {
  const { ctx, payload } = args;
  if (currentLabels instanceof Error) {
    logWarn("review_labels_fetch_failed", {
      mode: "review",
      owner: ctx.owner,
      repo: ctx.repo,
      pr: ctx.prNumber,
      message: currentLabels.message,
    });
    return;
  }
  if (!Array.isArray(currentLabels)) {
    logWarn("review_labels_fetch_failed", {
      mode: "review",
      owner: ctx.owner,
      repo: ctx.repo,
      pr: ctx.prNumber,
      message: `listPullRequestLabels returned non-array: ${String(currentLabels)}`,
    });
    return;
  }

  const wantsCategoryLabel = dominantReviewCategory(payload.findings) != null;
  const syncCategoryLabels = wantsCategoryLabel || hasManagedCategoryLabel(currentLabels);
  const syncEffortLabel = args.cfg.features.reviewLabels !== "off";
  const syncSecurityLabel = args.cfg.features.reviewLabels === "effort+security";
  if (!syncEffortLabel && !syncSecurityLabel && !syncCategoryLabels) return;

  try {
    if (
      labelsAlreadySynced(
        currentLabels,
        payload,
        {
          effort: syncEffortLabel,
          security: syncSecurityLabel,
          category: syncCategoryLabels,
        },
        "review",
      )
    ) {
      await args.recordPublishStep("labels", {
        meta: { labels: currentLabels, alreadySynced: true },
      });
      return;
    }
    const managed = reviewLabelsFromPayload(
      payload,
      {
        effort: syncEffortLabel,
        security: syncSecurityLabel,
        category: syncCategoryLabels,
      },
      "review",
    );
    const next = syncReviewLabels(currentLabels, managed, "review");
    await setPullRequestLabels(
      args.getToken(),
      ctx.owner,
      ctx.repo,
      ctx.prNumber,
      next,
      args.getTokenExpiresAtTs?.(),
    );
    await args.recordPublishStep("labels", { meta: { labels: next } });
    logDebug("review_labels_synced", {
      owner: ctx.owner,
      repo: ctx.repo,
      pr: ctx.prNumber,
      labels: next,
    });
  } catch (error) {
    logWarn("review_labels_sync_failed", {
      owner: ctx.owner,
      repo: ctx.repo,
      pr: ctx.prNumber,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function publishReviewSummaryOnly(
  args: PublishReviewSummaryOnlyArgs,
): Promise<{ summaryCommentId: number }> {
  await assertSummaryPublishAllowed(args);
  const { ctx, payload } = args;
  const summarySentinel = reviewSummarySentinelForMode("review");
  const summaryPlacements = await enrichFromReviewIds(args);
  const ciSummary = await buildCiSummary({
    token: args.getToken(),
    owner: ctx.owner,
    repo: ctx.repo,
    headSha: ctx.headSha,
    expiresAtTs: args.getTokenExpiresAtTs?.(),
    waitMs: REVIEW_CI_SUMMARY_WAIT_MS,
    waitPollMs: REVIEW_CI_SUMMARY_WAIT_POLL_MS,
    maxFailures: REVIEW_CI_SUMMARY_MAX_FAILURES,
    author: args.ciAuthor,
  });
  const metricsSnapshot = snapshotReviewRunMetrics();
  const summaryBody = renderReviewSummaryComment(payload, {
    ...ctx,
    summarySentinel,
    placements: summaryPlacements,
    mode: "review",
    partialCoverageNote: args.partialCoverageNote,
    staleReview: args.staleReview ?? false,
    cachedDiffIndex: args.cachedDiffIndex,
    ciSummary,
    runFooter: {
      durationMs: metricsSnapshot?.wallClockMs ?? 0,
      model: args.cfg.piModel,
    },
  });

  let knownSummaryCommentRef = args.knownSummaryCommentRef ?? null;
  if (args.shouldLinkToSummary && args.knownSummaryCommentRef === undefined) {
    const resolved = await resolveVerifiedSummaryCommentRef(
      args.getToken(),
      ctx.owner,
      ctx.repo,
      ctx.prNumber,
      summarySentinel,
      args.summaryCommentIdHint,
      args.getTokenExpiresAtTs?.(),
    );
    knownSummaryCommentRef = resolved ? { id: resolved.id, url: resolved.url } : null;
  }

  const labelsPromise = listPullRequestLabels(
    args.getToken(),
    ctx.owner,
    ctx.repo,
    ctx.prNumber,
    args.getTokenExpiresAtTs?.(),
  ).catch((error: unknown) => error);
  const summaryCoordination = args.recordPublishStep.summaryCommentCoordination;
  const summaryPromise = summaryCoordination
    ? upsertSummaryCommentWithCreationClaim({
        ...summaryCoordination,
        reviewLens: "review",
        token: args.getToken(),
        owner: ctx.owner,
        repo: ctx.repo,
        prNumber: ctx.prNumber,
        body: summaryBody,
        sentinel: summarySentinel,
        expiresAtTs: args.getTokenExpiresAtTs?.(),
        hintCommentId: args.summaryCommentIdHint ?? knownSummaryCommentRef?.id,
      })
    : upsertReviewSummaryComment(
        args.getToken(),
        ctx.owner,
        ctx.repo,
        ctx.prNumber,
        summaryBody,
        summarySentinel,
        knownSummaryCommentRef,
        args.getTokenExpiresAtTs?.(),
      );
  const [summary, currentLabels] = await Promise.all([summaryPromise, labelsPromise]);
  await args.recordPublishStep("summary_comment", {
    githubId: summary.id,
    meta: { updated: summary.updated, ...args.publishMeta },
  });
  logDebug("review_published_summary", {
    mode: "review",
    owner: ctx.owner,
    repo: ctx.repo,
    pr: ctx.prNumber,
    commentId: summary.id,
    updated: summary.updated,
  });

  const checkOutcome = reviewCheckRunOutcome(payload.findings);
  const targetUrl = reviewCheckDetailsUrl(ctx.owner, ctx.repo, ctx.prNumber, summary.id);
  if (summaryCoordination) {
    await completeReviewCheckRun(summaryCoordination.pool, {
      token: args.getToken(),
      tokenExpiresAtTs: args.getTokenExpiresAtTs?.(),
      owner: ctx.owner,
      repo: ctx.repo,
      prNumber: ctx.prNumber,
      workItemId: summaryCoordination.workItemId,
      resourceKey: summaryCoordination.resourceKey,
      reviewLens: "review",
      conclusion: checkOutcome.conclusion,
      summary: checkOutcome.summary,
      detailsUrl: targetUrl,
    });
  }

  if (args.cfg.features.commitStatus) {
    try {
      await setReviewCommitStatus(
        args.getToken(),
        ctx.owner,
        ctx.repo,
        ctx.headSha,
        {
          state: checkOutcome.conclusion === "failure" ? "failure" : "success",
          description: checkOutcome.summary,
          targetUrl,
        },
        args.getTokenExpiresAtTs?.(),
      );
    } catch (error) {
      logWarn("review_commit_status_failed", {
        mode: "review",
        owner: ctx.owner,
        repo: ctx.repo,
        pr: ctx.prNumber,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await syncLabels(args, currentLabels);
  return { summaryCommentId: summary.id };
}
