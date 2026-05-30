import type { Config } from "../../config.js";
import { enrichPlacementsWithInlineCommentUrls } from "./placementEnrichment.js";
import {
  listPullRequestLabels,
  listPullRequestReviewCommentsForReview,
  resolveVerifiedSummaryCommentUrl,
  setPullRequestLabels,
  upsertReviewSummaryComment,
} from "../../github/reviewPublish.js";
import { labelsAlreadySynced, reviewLabelsFromPayload, syncReviewLabels } from "../reviewLabels.js";
import { logWarn, logDebug } from "../../evlog.js";
import { MAX_INLINE_REVIEW_COMMENTS } from "../../settings/index.js";
import { renderReviewSummaryComment } from "../reviewRender.js";
import {
  applyInlineCommentCap,
  planInlinePlacements,
  type CachedPrDiffIndex,
} from "../reviewDiffPlacement.js";
import { runInlinePublishPhase } from "../reviewPublishInlinePhase.js";
import {
  mergeInlineFingerprintRecords,
  suppressInlinePlacementsByFingerprint,
} from "../reviewFindingFingerprint.js";
import {
  reviewEventForFindings,
  isInlineSeverity,
  reviewSummarySentinelForMode,
  type ReviewFinding,
  type ReviewMode,
  type ReviewPayload,
  type ReviewPublishContext,
} from "../reviewSchema.js";
import type { SubmitReviewState } from "./submitReviewTool.js";

function fingerprintsForInlineReviewStep(params: {
  storedInlineFingerprints: readonly string[];
  inlinePostedFindings: readonly ReviewFinding[];
  mode: ReviewMode;
}): string[] {
  return mergeInlineFingerprintRecords(
    params.storedInlineFingerprints,
    params.inlinePostedFindings,
    params.mode,
  );
}

export async function publishReview(
  params: ReviewPublishContext & {
    token: string;
    mode?: ReviewMode;
    cfg: Pick<Config, "enableReviewLabelsEffort" | "enableReviewLabelsSecurity">;
    payload: ReviewPayload;
    /** Set when payload was already normalized, deduped, and validated by submitReview. */
    dedupedFindingCount?: number;
    publishState: SubmitReviewState;
    cachedDiffIndex?: CachedPrDiffIndex;
    shouldLinkToSummary?: boolean;
    summaryCommentIdHint?: number | null;
    staleReview?: boolean;
    recordPublishStep?: (
      step: "inline_review" | "summary_comment" | "labels",
      detail?: { githubId?: string | number; meta?: Record<string, unknown> },
    ) => Promise<void>;
    storedInlineFingerprints?: readonly string[];
  },
): Promise<void> {
  const { token, owner, repo, prNumber, headSha, cfg, payload, publishState } = params;
  const mode = params.mode ?? "review";
  const summarySentinel = reviewSummarySentinelForMode(mode);
  const storedInlineFingerprints = params.storedInlineFingerprints ?? [];
  const inlineReviewFingerprints = (inlinePostedFindings: readonly ReviewFinding[]) =>
    fingerprintsForInlineReviewStep({
      storedInlineFingerprints,
      inlinePostedFindings,
      mode,
    });

  let placements = planInlinePlacements(payload.findings, params.cachedDiffIndex);
  const suppression = suppressInlinePlacementsByFingerprint(
    placements,
    mode,
    storedInlineFingerprints,
  );
  placements = suppression.placements;
  const inlineCap = applyInlineCommentCap(placements, MAX_INLINE_REVIEW_COMMENTS);
  placements = inlineCap.placements;
  const inlineFindings = placements.filter((p) => p.inlinePosted);
  const event = reviewEventForFindings(payload.findings);
  let summaryPlacements = placements;
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
  if (params.shouldLinkToSummary) {
    summaryCommentUrl = await resolveVerifiedSummaryCommentUrl(
      token,
      owner,
      repo,
      prNumber,
      summarySentinel,
      params.summaryCommentIdHint,
    );
  }

  const publishMetaBase = {
    inlineCount: inlineFindings.length,
    summaryOnlyCount: placements.filter((p) => !p.inlinePosted).length,
    inlineCommentCapExcluded: inlineCap.inlineCommentCapExcluded,
    anchorUnresolved: placements.filter(
      (p) => isInlineSeverity(p.finding.severity) && p.inlineLine == null,
    ).length,
    dedupedFindingCount: params.dedupedFindingCount ?? 0,
    suppressedInlineCount: suppression.suppressedInlineCount,
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
      const reviewComments = await listPullRequestReviewCommentsForReview(
        token,
        owner,
        repo,
        prNumber,
        inlineReviewId,
      );
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
  });

  const summary = await upsertReviewSummaryComment(
    token,
    owner,
    repo,
    prNumber,
    summaryBody,
    summarySentinel,
  );
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

  if (cfg.enableReviewLabelsEffort || cfg.enableReviewLabelsSecurity) {
    try {
      const current = await listPullRequestLabels(token, owner, repo, prNumber);
      if (
        labelsAlreadySynced(current, payload, {
          effort: cfg.enableReviewLabelsEffort,
          security: cfg.enableReviewLabelsSecurity,
        })
      ) {
        await params.recordPublishStep?.("labels", {
          meta: { labels: current, alreadySynced: true },
        });
        return;
      }
      const managed = reviewLabelsFromPayload(payload, {
        effort: cfg.enableReviewLabelsEffort,
        security: cfg.enableReviewLabelsSecurity,
      });
      const next = syncReviewLabels(current, managed);
      await setPullRequestLabels(token, owner, repo, prNumber, next);
      await params.recordPublishStep?.("labels", { meta: { labels: next } });
      logDebug("review_labels_synced", { owner, repo, pr: prNumber, labels: next });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logWarn("review_labels_sync_failed", { owner, repo, pr: prNumber, message });
    }
  }
}
