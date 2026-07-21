import type { Config } from "../../config.js";
import type { Pool } from "pg";
import {
  claimSummaryCommentCreation,
  getSummaryCommentGithubId,
} from "../../agentWork/repository.js";
import {
  completeReviewCheckRun,
  reviewCheckDetailsUrl,
  reviewCheckRunOutcome,
} from "../../agentWork/reviewCheckRun.js";
import { logDebug, logWarn } from "../../evlog.js";
import {
  findIssueCommentBySentinel,
  listPullRequestLabels,
  listPullRequestReviewCommentsForReview,
  resolveVerifiedSummaryCommentRef,
  setPullRequestLabels,
  setReviewCommitStatus,
  upsertReviewSummaryComment,
} from "../../github/reviewPublish.js";
import {
  REVIEW_CI_SUMMARY_MAX_FAILURES,
  REVIEW_CI_SUMMARY_WAIT_MS,
  REVIEW_CI_SUMMARY_WAIT_POLL_MS,
  REVIEW_PUBLISH_TRANSIENT_RETRY_DELAYS_MS,
} from "../../settings/index.js";
import type { AnyReviewLens } from "../../settings/legacyReviewLenses.js";
import { buildCiSummary } from "../ci/analyzeCi.js";
import type { CiSummaryAuthor } from "../ci/authorCiSummary.js";
import type { FindingLedger } from "../orchestrator/orchestratorTypes.js";
import { enrichPlacementsWithInlineCommentUrls } from "./placementEnrichment.js";
import type { CachedPrDiffIndex } from "../placement/reviewDiffIndex.js";
import {
  dominantReviewCategory,
  hasManagedCategoryLabel,
  labelsAlreadySynced,
  reviewLabelsFromPayload,
  syncReviewLabels,
} from "../run/reviewLabels.js";
import { renderReviewSummaryComment } from "../run/reviewRender.js";
import { snapshotReviewRunMetrics } from "../run/reviewRunMetrics.js";
import {
  reviewSummarySentinelForMode,
  type ReviewPayload,
  type ReviewPublishContext,
} from "../reviewSchema.js";

export type SummaryCommentCoordination = {
  pool: Pool;
  workItemId: string;
  resourceKey: string;
};

export type RecordPublishStepFn = (
  step: "inline_review" | "summary_comment" | "labels",
  detail?: { githubId?: string | number; meta?: Record<string, unknown> },
) => Promise<void>;

export type RecordPublishStepWithCoordination = RecordPublishStepFn & {
  summaryCommentCoordination?: SummaryCommentCoordination;
};

export function attachSummaryCommentCoordination(
  recordPublishStep: RecordPublishStepFn,
  coordination: SummaryCommentCoordination,
): RecordPublishStepWithCoordination {
  return Object.assign(recordPublishStep, { summaryCommentCoordination: coordination });
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveKnownSummaryCommentRef(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  sentinel: string,
  hintCommentId: number | null | undefined,
  expiresAtTs?: number,
): Promise<{ id: number; url: string } | null> {
  const resolved = await resolveVerifiedSummaryCommentRef(
    token,
    owner,
    repo,
    prNumber,
    sentinel,
    hintCommentId,
    expiresAtTs,
  );
  return resolved ? { id: resolved.id, url: resolved.url } : null;
}

export async function upsertSummaryCommentWithCreationClaim(params: {
  pool: Pool;
  workItemId: string;
  resourceKey: string;
  reviewLens: AnyReviewLens;
  token: string;
  owner: string;
  repo: string;
  prNumber: number;
  body: string;
  sentinel: string;
  expiresAtTs?: number;
  hintCommentId?: number | null;
}): Promise<{ id: number; updated: boolean }> {
  const {
    pool,
    workItemId,
    resourceKey,
    reviewLens,
    token,
    owner,
    repo,
    prNumber,
    body,
    sentinel,
    expiresAtTs,
  } = params;

  const storedId = await getSummaryCommentGithubId(pool, resourceKey, reviewLens);
  const hintId = params.hintCommentId ?? storedId ?? null;
  const knownFromStored = await resolveKnownSummaryCommentRef(
    token,
    owner,
    repo,
    prNumber,
    sentinel,
    hintId,
    expiresAtTs,
  );
  if (knownFromStored) {
    return upsertReviewSummaryComment(
      token,
      owner,
      repo,
      prNumber,
      body,
      sentinel,
      knownFromStored,
      expiresAtTs,
    );
  }

  const claimWon = await claimSummaryCommentCreation(pool, workItemId, resourceKey, reviewLens);
  if (claimWon) {
    const scanned = await findIssueCommentBySentinel(
      token,
      owner,
      repo,
      prNumber,
      sentinel,
      expiresAtTs,
    );
    return upsertReviewSummaryComment(
      token,
      owner,
      repo,
      prNumber,
      body,
      sentinel,
      scanned,
      expiresAtTs,
    );
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      const delay =
        REVIEW_PUBLISH_TRANSIENT_RETRY_DELAYS_MS[attempt - 1] ??
        REVIEW_PUBLISH_TRANSIENT_RETRY_DELAYS_MS.at(-1) ??
        0;
      await sleepMs(delay);
    }
    const polledId = await getSummaryCommentGithubId(pool, resourceKey, reviewLens);
    if (polledId == null) continue;
    const knownFromPoll = await resolveKnownSummaryCommentRef(
      token,
      owner,
      repo,
      prNumber,
      sentinel,
      polledId,
      expiresAtTs,
    );
    if (knownFromPoll) {
      return upsertReviewSummaryComment(
        token,
        owner,
        repo,
        prNumber,
        body,
        sentinel,
        knownFromPoll,
        expiresAtTs,
      );
    }
  }

  const scanned = await findIssueCommentBySentinel(
    token,
    owner,
    repo,
    prNumber,
    sentinel,
    expiresAtTs,
  );
  return upsertReviewSummaryComment(
    token,
    owner,
    repo,
    prNumber,
    body,
    sentinel,
    scanned,
    expiresAtTs,
  );
}

export type PublishSummaryOnlyResult =
  | { readonly kind: "published"; readonly summaryCommentId: number }
  | { readonly kind: "stopped"; readonly reason: "superseded" | "stale_head" };

export async function publishReviewSummaryOnly(params: {
  readonly cfg: Pick<Config, "piModel" | "features">;
  readonly ctx: ReviewPublishContext;
  readonly getToken: () => string;
  readonly getTokenExpiresAtTs?: () => number | undefined;
  readonly payload: ReviewPayload;
  readonly ledger: FindingLedger;
  readonly mode?: AnyReviewLens;
  readonly cachedDiffIndex?: CachedPrDiffIndex;
  readonly shouldLinkToSummary?: boolean;
  readonly summaryCommentIdHint?: number | null;
  readonly staleReview?: boolean;
  readonly recordPublishStep?: RecordPublishStepWithCoordination;
  readonly ciAuthor?: CiSummaryAuthor;
  readonly partialCoverageNote?: string;
  readonly shouldAbortPublish?: () => Promise<boolean>;
  readonly publishAbortState?: { readonly staleHead?: boolean };
  readonly dedupedFindingCount?: number;
}): Promise<PublishSummaryOnlyResult> {
  const { owner, repo, prNumber, headSha } = params.ctx;
  const mode = params.mode ?? "review";
  const summarySentinel = reviewSummarySentinelForMode(mode);
  const summaryPlacements = params.ledger.accepted.map((accepted) => accepted.placement);
  const reviewComments: Awaited<ReturnType<typeof listPullRequestReviewCommentsForReview>> = [];
  for (const inlineReviewId of params.ledger.inlineReviewIds) {
    try {
      const token = params.getToken();
      const tokenExpiresAtTs = params.getTokenExpiresAtTs?.();
      reviewComments.push(
        ...(await listPullRequestReviewCommentsForReview(
          token,
          owner,
          repo,
          prNumber,
          inlineReviewId,
          tokenExpiresAtTs,
        )),
      );
    } catch (error) {
      logWarn("review_inline_comment_urls_failed", {
        mode,
        owner,
        repo,
        pr: prNumber,
        reviewId: inlineReviewId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const enrichedPlacements = enrichPlacementsWithInlineCommentUrls(
    summaryPlacements,
    reviewComments,
  );

  const metricsSnapshot = snapshotReviewRunMetrics();
  const ciToken = params.getToken();
  const ciTokenExpiresAtTs = params.getTokenExpiresAtTs?.();
  const ciSummary = await buildCiSummary({
    token: ciToken,
    owner,
    repo,
    headSha,
    expiresAtTs: ciTokenExpiresAtTs,
    waitMs: REVIEW_CI_SUMMARY_WAIT_MS,
    waitPollMs: REVIEW_CI_SUMMARY_WAIT_POLL_MS,
    maxFailures: REVIEW_CI_SUMMARY_MAX_FAILURES,
    author: params.ciAuthor,
  });
  const summaryBody = renderReviewSummaryComment(params.payload, {
    ...params.ctx,
    summarySentinel,
    placements: enrichedPlacements,
    mode,
    staleReview: params.staleReview ?? false,
    cachedDiffIndex: params.cachedDiffIndex,
    ciSummary,
    partialCoverageNote: params.partialCoverageNote,
    runFooter: {
      durationMs: metricsSnapshot?.wallClockMs ?? 0,
      model: params.cfg.piModel,
    },
  });

  let shouldAbort = false;
  try {
    shouldAbort = (await params.shouldAbortPublish?.()) ?? false;
  } catch (error) {
    logWarn("review_summary_abort_check_failed", {
      mode,
      owner,
      repo,
      pr: prNumber,
      message: error instanceof Error ? error.message : String(error),
    });
    shouldAbort = true;
  }
  if (shouldAbort) {
    return {
      kind: "stopped",
      reason: params.publishAbortState?.staleHead === true ? "stale_head" : "superseded",
    };
  }

  const summaryToken = params.getToken();
  const summaryTokenExpiresAtTs = params.getTokenExpiresAtTs?.();
  let knownSummaryCommentRef: { id: number; url: string } | null = null;
  if (params.shouldLinkToSummary) {
    const resolvedSummary = await resolveVerifiedSummaryCommentRef(
      summaryToken,
      owner,
      repo,
      prNumber,
      summarySentinel,
      params.summaryCommentIdHint,
      summaryTokenExpiresAtTs,
    );
    knownSummaryCommentRef = resolvedSummary
      ? { id: resolvedSummary.id, url: resolvedSummary.url }
      : null;
  }

  const labelsToken = params.getToken();
  const labelsTokenExpiresAtTs = params.getTokenExpiresAtTs?.();
  const labelsPromise = listPullRequestLabels(
    labelsToken,
    owner,
    repo,
    prNumber,
    labelsTokenExpiresAtTs,
  ).catch((error: unknown) => error);
  const summaryCoordination = params.recordPublishStep?.summaryCommentCoordination;
  const summaryUpsert = summaryCoordination
    ? upsertSummaryCommentWithCreationClaim({
        ...summaryCoordination,
        reviewLens: mode,
        token: summaryToken,
        owner,
        repo,
        prNumber,
        body: summaryBody,
        sentinel: summarySentinel,
        expiresAtTs: summaryTokenExpiresAtTs,
        hintCommentId: params.summaryCommentIdHint ?? knownSummaryCommentRef?.id,
      })
    : upsertReviewSummaryComment(
        summaryToken,
        owner,
        repo,
        prNumber,
        summaryBody,
        summarySentinel,
        knownSummaryCommentRef,
        summaryTokenExpiresAtTs,
      );
  const [summary, currentLabels] = await Promise.all([summaryUpsert, labelsPromise]);
  const summaryOnlyCount = params.ledger.accepted.filter(
    (accepted) => accepted.kind === "summary_only",
  ).length;
  await params.recordPublishStep?.("summary_comment", {
    githubId: summary.id,
    meta: {
      inlineCount: params.ledger.postedInlineCount,
      summaryOnlyCount,
      dedupedFindingCount: params.dedupedFindingCount ?? 0,
      diffCacheEmpty: params.cachedDiffIndex == null || params.cachedDiffIndex.files.size === 0,
      updated: summary.updated,
    },
  });
  logDebug("review_published_summary", {
    mode,
    owner,
    repo,
    pr: prNumber,
    commentId: summary.id,
    updated: summary.updated,
  });

  const checkOutcome = reviewCheckRunOutcome(params.payload.findings);
  const targetUrl = reviewCheckDetailsUrl(owner, repo, prNumber, summary.id);
  if (summaryCoordination) {
    const checkToken = params.getToken();
    const checkTokenExpiresAtTs = params.getTokenExpiresAtTs?.();
    await completeReviewCheckRun(summaryCoordination.pool, {
      token: checkToken,
      tokenExpiresAtTs: checkTokenExpiresAtTs,
      owner,
      repo,
      prNumber,
      workItemId: summaryCoordination.workItemId,
      resourceKey: summaryCoordination.resourceKey,
      reviewLens: mode,
      conclusion: checkOutcome.conclusion,
      summary: checkOutcome.summary,
      detailsUrl: targetUrl,
    });
  }

  if (params.cfg.features.commitStatus) {
    try {
      const commitStatusToken = params.getToken();
      const commitStatusTokenExpiresAtTs = params.getTokenExpiresAtTs?.();
      await setReviewCommitStatus(
        commitStatusToken,
        owner,
        repo,
        headSha,
        {
          state: checkOutcome.conclusion === "failure" ? "failure" : "success",
          description: checkOutcome.summary,
          targetUrl,
        },
        commitStatusTokenExpiresAtTs,
      );
    } catch (error) {
      logWarn("review_commit_status_failed", {
        mode,
        owner,
        repo,
        pr: prNumber,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (currentLabels instanceof Error) {
    logWarn("review_labels_fetch_failed", {
      mode,
      owner,
      repo,
      pr: prNumber,
      message: currentLabels.message,
    });
    return { kind: "published", summaryCommentId: summary.id };
  }
  if (!Array.isArray(currentLabels)) {
    logWarn("review_labels_fetch_failed", {
      mode,
      owner,
      repo,
      pr: prNumber,
      message: `listPullRequestLabels returned non-array: ${String(currentLabels)}`,
    });
    return { kind: "published", summaryCommentId: summary.id };
  }

  const wantsCategoryLabel = dominantReviewCategory(params.payload.findings) != null;
  const syncCategoryLabels =
    mode === "review" && (wantsCategoryLabel || hasManagedCategoryLabel(currentLabels));
  const syncEffortLabel = params.cfg.features.reviewLabels !== "off";
  const syncSecurityLabel = params.cfg.features.reviewLabels === "effort+security";
  if (syncEffortLabel || syncSecurityLabel || syncCategoryLabels) {
    try {
      const options = {
        effort: syncEffortLabel,
        security: syncSecurityLabel,
        category: syncCategoryLabels,
      };
      if (labelsAlreadySynced(currentLabels, params.payload, options, mode)) {
        await params.recordPublishStep?.("labels", {
          meta: { labels: currentLabels, alreadySynced: true },
        });
      } else {
        const managed = reviewLabelsFromPayload(params.payload, options, mode);
        const next = syncReviewLabels(currentLabels, managed, mode);
        const labelsWriteToken = params.getToken();
        const labelsWriteTokenExpiresAtTs = params.getTokenExpiresAtTs?.();
        await setPullRequestLabels(
          labelsWriteToken,
          owner,
          repo,
          prNumber,
          next,
          labelsWriteTokenExpiresAtTs,
        );
        await params.recordPublishStep?.("labels", { meta: { labels: next } });
        logDebug("review_labels_synced", { owner, repo, pr: prNumber, labels: next });
      }
    } catch (error) {
      logWarn("review_labels_sync_failed", {
        owner,
        repo,
        pr: prNumber,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { kind: "published", summaryCommentId: summary.id };
}
