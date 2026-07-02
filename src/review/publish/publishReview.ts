import type { Config } from "../../config.js";
import type { Pool } from "pg";
import { enrichPlacementsWithInlineCommentUrls } from "./placementEnrichment.js";
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
  claimSummaryCommentCreation,
  getSummaryCommentGithubId,
} from "../../agentWork/repository.js";
import { completeReviewCheckRun, reviewCheckDetailsUrl } from "../../agentWork/reviewCheckRun.js";
import {
  labelsAlreadySynced,
  reviewLabelsFromPayload,
  syncReviewLabels,
  dominantReviewCategory,
  hasManagedCategoryLabel,
} from "../run/reviewLabels.js";
import { logWarn, logDebug } from "../../evlog.js";
import { REVIEW_PUBLISH_TRANSIENT_RETRY_DELAYS_MS } from "../../settings/index.js";
import { renderReviewSummaryComment } from "../run/reviewRender.js";
import {
  type FingerprintedInlinePlacement,
  type InlinePlacement,
} from "../placement/reviewDiffPlacement.js";
import type { CachedPrDiffIndex } from "../placement/reviewDiffIndex.js";
import { runInlinePublishPhase } from "../run/reviewPublishInlinePhase.js";
import { mergeInlineFingerprintRecords } from "../findings/reviewFindingFingerprint.js";
import { prepareFindingsForPublish } from "../findings/findingPipeline.js";
import {
  reviewEventForFindings,
  reviewSummarySentinelForMode,
  type ReviewMode,
  type ReviewPayload,
  type ReviewPublishContext,
} from "../reviewSchema.js";
import type { SubmitReviewState } from "./submitReviewTool.js";

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
  const wrapped = recordPublishStep as RecordPublishStepWithCoordination;
  wrapped.summaryCommentCoordination = coordination;
  return wrapped;
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
  const resolved =
    expiresAtTs == null
      ? await resolveVerifiedSummaryCommentRef(
          token,
          owner,
          repo,
          prNumber,
          sentinel,
          hintCommentId,
        )
      : await resolveVerifiedSummaryCommentRef(
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
  reviewLens: ReviewMode;
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
        REVIEW_PUBLISH_TRANSIENT_RETRY_DELAYS_MS.at(-1)!;
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

export async function publishReview(
  params: ReviewPublishContext & {
    token: string;
    mode?: ReviewMode;
    cfg: Pick<
      Config,
      | "enableReviewLabelsEffort"
      | "enableReviewLabelsSecurity"
      | "enableReviewCommitStatus"
      | "enableReviewCheckRun"
    >;
    payload: ReviewPayload;
    tokenExpiresAtTs?: number;
    /** Set when payload was already normalized, deduped, and validated by submitReview. */
    dedupedFindingCount?: number;
    publishState: SubmitReviewState;
    cachedDiffIndex?: CachedPrDiffIndex;
    shouldLinkToSummary?: boolean;
    summaryCommentIdHint?: number | null;
    staleReview?: boolean;
    recordPublishStep?: RecordPublishStepWithCoordination;
    storedInlineFingerprints?: readonly string[];
    /** Reuse placements already computed during prepare; recomputed when omitted. */
    inlinePlacements?: readonly InlinePlacement[];
  },
): Promise<void> {
  const { token, owner, repo, prNumber, headSha, cfg, payload, publishState } = params;
  const tokenExpiresAtTs = params.tokenExpiresAtTs;
  const mode = params.mode ?? "review";
  const summarySentinel = reviewSummarySentinelForMode(mode);
  const storedInlineFingerprints = params.storedInlineFingerprints ?? [];
  const inlineReviewFingerprints = (placements: readonly FingerprintedInlinePlacement[]) =>
    mergeInlineFingerprintRecords(storedInlineFingerprints, placements);

  const preparedFindings = prepareFindingsForPublish({
    payload,
    mode,
    cachedDiffIndex: params.cachedDiffIndex,
    inlinePlacements: params.inlinePlacements,
    storedInlineFingerprints,
  });
  const placements = preparedFindings.placements;
  const inlineFindings = preparedFindings.inline;
  const event = reviewEventForFindings(payload.findings);
  let summaryPlacements: InlinePlacement[] = [...placements];
  let inlineReviewId = publishState.inlineReviewId;
  const diffCacheEmpty = params.cachedDiffIndex == null || params.cachedDiffIndex.files.size === 0;
  if (diffCacheEmpty) {
    logDebug("review_diff_cache_empty", {
      mode,
      owner,
      repo,
      pr: prNumber,
      truncated: params.cachedDiffIndex?.truncated ?? false,
    });
  }

  const renderCtx = {
    owner,
    repo,
    prNumber,
    headSha,
  };

  let summaryCommentUrl: string | undefined;
  let knownSummaryCommentRef: { id: number; url: string } | null = null;
  if (params.shouldLinkToSummary) {
    let resolvedSummary;
    if (tokenExpiresAtTs == null) {
      resolvedSummary = await resolveVerifiedSummaryCommentRef(
        token,
        owner,
        repo,
        prNumber,
        summarySentinel,
        params.summaryCommentIdHint,
      );
    } else {
      resolvedSummary = await resolveVerifiedSummaryCommentRef(
        token,
        owner,
        repo,
        prNumber,
        summarySentinel,
        params.summaryCommentIdHint,
        tokenExpiresAtTs,
      );
    }
    summaryCommentUrl = resolvedSummary?.url;
    knownSummaryCommentRef = resolvedSummary
      ? { id: resolvedSummary.id, url: resolvedSummary.url }
      : null;
  }

  const publishMetaBase = {
    inlineCount: inlineFindings.length,
    summaryOnlyCount: preparedFindings.summaryOnly.length,
    inlineCommentCapExcluded: preparedFindings.dropped.inlineCommentCapExcluded,
    anchorUnresolved: preparedFindings.dropped.anchorUnresolved,
    dedupedFindingCount: params.dedupedFindingCount ?? 0,
    suppressedInlineCount: preparedFindings.dropped.suppressedInlineCount,
    diffCacheEmpty,
  };

  if (!publishState.inlinePublished) {
    const inlinePhase = await runInlinePublishPhase({
      token,
      mode,
      payload,
      ctx: renderCtx,
      placements,
      inlineFindings,
      event,
      summaryCommentUrl,
      shouldLinkToSummary: params.shouldLinkToSummary ?? false,
      publishState,
      publishMetaBase,
      inlineReviewFingerprints,
      recordPublishStep: params.recordPublishStep,
    });
    summaryPlacements = inlinePhase.summaryPlacements;
    inlineReviewId = inlinePhase.inlineReviewId;
    publishState.inlinePublished = true;
  }

  if (inlineReviewId != null) {
    try {
      let reviewComments;
      if (tokenExpiresAtTs == null) {
        reviewComments = await listPullRequestReviewCommentsForReview(
          token,
          owner,
          repo,
          prNumber,
          inlineReviewId,
        );
      } else {
        reviewComments = await listPullRequestReviewCommentsForReview(
          token,
          owner,
          repo,
          prNumber,
          inlineReviewId,
          tokenExpiresAtTs,
        );
      }
      summaryPlacements = enrichPlacementsWithInlineCommentUrls(summaryPlacements, reviewComments);
    } catch (e) {
      logWarn("review_inline_comment_urls_failed", {
        mode,
        owner,
        repo,
        pr: prNumber,
        reviewId: inlineReviewId,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const summaryBody = renderReviewSummaryComment(payload, {
    ...renderCtx,
    summarySentinel,
    placements: summaryPlacements,
    mode,
    staleReview: params.staleReview ?? false,
    cachedDiffIndex: params.cachedDiffIndex,
  });

  const labelsPromise = (
    tokenExpiresAtTs == null
      ? listPullRequestLabels(token, owner, repo, prNumber)
      : listPullRequestLabels(token, owner, repo, prNumber, tokenExpiresAtTs)
  ).catch((e: unknown) => e);

  let summaryUpsert: Promise<{ id: number; updated: boolean }>;
  const summaryCoordination = params.recordPublishStep?.summaryCommentCoordination;
  if (summaryCoordination) {
    summaryUpsert = upsertSummaryCommentWithCreationClaim({
      ...summaryCoordination,
      reviewLens: mode,
      token,
      owner,
      repo,
      prNumber,
      body: summaryBody,
      sentinel: summarySentinel,
      expiresAtTs: tokenExpiresAtTs,
      hintCommentId: params.summaryCommentIdHint ?? knownSummaryCommentRef?.id,
    });
  } else if (knownSummaryCommentRef != null) {
    summaryUpsert =
      tokenExpiresAtTs == null
        ? upsertReviewSummaryComment(
            token,
            owner,
            repo,
            prNumber,
            summaryBody,
            summarySentinel,
            knownSummaryCommentRef,
          )
        : upsertReviewSummaryComment(
            token,
            owner,
            repo,
            prNumber,
            summaryBody,
            summarySentinel,
            knownSummaryCommentRef,
            tokenExpiresAtTs,
          );
  } else if (tokenExpiresAtTs == null) {
    summaryUpsert = upsertReviewSummaryComment(
      token,
      owner,
      repo,
      prNumber,
      summaryBody,
      summarySentinel,
    );
  } else {
    summaryUpsert = upsertReviewSummaryComment(
      token,
      owner,
      repo,
      prNumber,
      summaryBody,
      summarySentinel,
      undefined,
      tokenExpiresAtTs,
    );
  }
  const [summary, currentLabels] = await Promise.all([summaryUpsert, labelsPromise]);
  await params.recordPublishStep?.("summary_comment", {
    githubId: summary.id,
    meta: { updated: summary.updated, ...publishMetaBase },
  });
  logDebug("review_published_summary", {
    mode,
    owner,
    repo,
    pr: prNumber,
    commentId: summary.id,
    updated: summary.updated,
  });

  const blockingCount = payload.findings.filter(
    (f) => f.severity === "P0" || f.severity === "P1",
  ).length;
  const statusDescription =
    blockingCount > 0
      ? `${blockingCount} P0/P1 finding${blockingCount === 1 ? "" : "s"}`
      : "no blocking findings";
  const targetUrl = reviewCheckDetailsUrl(owner, repo, prNumber, summary.id);

  if (cfg.enableReviewCheckRun && summaryCoordination) {
    await completeReviewCheckRun(summaryCoordination.pool, {
      cfg,
      token,
      tokenExpiresAtTs,
      owner,
      repo,
      prNumber,
      workItemId: summaryCoordination.workItemId,
      resourceKey: summaryCoordination.resourceKey,
      reviewLens: mode,
      conclusion: blockingCount > 0 ? "failure" : "success",
      summary: statusDescription,
      detailsUrl: targetUrl,
    });
  }

  if (cfg.enableReviewCommitStatus) {
    const statusState = blockingCount > 0 ? "failure" : "success";
    try {
      if (tokenExpiresAtTs == null) {
        await setReviewCommitStatus(token, owner, repo, headSha, {
          state: statusState,
          description: statusDescription,
          targetUrl,
        });
      } else {
        await setReviewCommitStatus(
          token,
          owner,
          repo,
          headSha,
          {
            state: statusState,
            description: statusDescription,
            targetUrl,
          },
          tokenExpiresAtTs,
        );
      }
    } catch (e) {
      logWarn("review_commit_status_failed", {
        mode,
        owner,
        repo,
        pr: prNumber,
        message: e instanceof Error ? e.message : String(e),
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
    return;
  }
  if (!Array.isArray(currentLabels)) {
    logWarn("review_labels_fetch_failed", {
      mode,
      owner,
      repo,
      pr: prNumber,
      message: `listPullRequestLabels returned non-array: ${String(currentLabels)}`,
    });
    return;
  }

  const wantsCategoryLabel = dominantReviewCategory(payload.findings) != null;
  const syncCategoryLabels =
    mode === "review" && (wantsCategoryLabel || hasManagedCategoryLabel(currentLabels));
  const shouldSyncLabels =
    cfg.enableReviewLabelsEffort || cfg.enableReviewLabelsSecurity || syncCategoryLabels;

  if (shouldSyncLabels) {
    try {
      if (
        labelsAlreadySynced(
          currentLabels,
          payload,
          {
            effort: cfg.enableReviewLabelsEffort,
            security: cfg.enableReviewLabelsSecurity,
            category: syncCategoryLabels,
          },
          mode,
        )
      ) {
        await params.recordPublishStep?.("labels", {
          meta: { labels: currentLabels, alreadySynced: true },
        });
        return;
      }
      const managed = reviewLabelsFromPayload(
        payload,
        {
          effort: cfg.enableReviewLabelsEffort,
          security: cfg.enableReviewLabelsSecurity,
          category: syncCategoryLabels,
        },
        mode,
      );
      const next = syncReviewLabels(currentLabels, managed, mode);
      if (tokenExpiresAtTs == null) {
        await setPullRequestLabels(token, owner, repo, prNumber, next);
      } else {
        await setPullRequestLabels(token, owner, repo, prNumber, next, tokenExpiresAtTs);
      }
      await params.recordPublishStep?.("labels", { meta: { labels: next } });
      logDebug("review_labels_synced", {
        owner,
        repo,
        pr: prNumber,
        labels: next,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logWarn("review_labels_sync_failed", {
        owner,
        repo,
        pr: prNumber,
        message,
      });
    }
  }
}
