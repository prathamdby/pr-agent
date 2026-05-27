import type { Config } from "../config.js";
import {
  enrichPlacementsWithInlineCommentUrls,
  listPullRequestLabels,
  listPullRequestReviewCommentsForReview,
  resolveVerifiedSummaryCommentUrl,
  setPullRequestLabels,
  upsertReviewSummaryComment,
} from "../github/reviewPublish.js";
import { createPullRequestReviewWithComments } from "../github/reviewPublish.js";
import { labelsAlreadySynced, reviewLabelsFromPayload, syncReviewLabels } from "./reviewLabels.js";
import { logWarn, logDebug } from "../evlog.js";
import { MAX_INLINE_REVIEW_COMMENTS } from "../settings/index.js";
import {
  renderInlineThreadBody,
  renderRepeatNoBugsReviewBody,
  renderReviewPointerBody,
  renderReviewSummaryComment,
} from "./reviewRender.js";
import {
  applyInlineCommentCap,
  downgradePlacementsAfterInlineFailure,
  planInlinePlacements,
  type CachedPrDiffIndex,
} from "./reviewDiffPlacement.js";
import { publishInlineReviewComments } from "./reviewInlinePublish.js";
import {
  mergeInlineFingerprintRecords,
  suppressInlinePlacementsByFingerprint,
} from "./reviewFindingFingerprint.js";
import {
  reviewEventForFindings,
  isInlineSeverity,
  reviewSummarySentinelForMode,
  type ReviewFinding,
  type ReviewMode,
  type ReviewPayload,
  type ReviewPublishContext,
} from "./reviewSchema.js";
import type { SubmitReviewState } from "./submitReviewTool.js";
import type { InlinePlacement } from "./reviewDiffPlacement.js";

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

function mergeDroppedIntoSummaryPlacements(
  placements: readonly InlinePlacement[],
  dropped: readonly InlinePlacement[],
): InlinePlacement[] {
  if (dropped.length === 0) return [...placements];
  const droppedByFinding = new Map(dropped.map((placement) => [placement.finding, placement]));
  return placements.map((placement) => droppedByFinding.get(placement.finding) ?? placement);
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
  let inlineFindings = placements.filter((p) => p.inlinePosted);
  const event = reviewEventForFindings(payload.findings);
  let summaryPlacements = placements;
  let anchorDroppedPlacements: InlinePlacement[] = [];
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
  };

  if (!publishState.inlinePublished) {
    if (inlineFindings.length > 0) {
      try {
        const inlineResult = await publishInlineReviewComments(token, owner, repo, prNumber, {
          renderReviewBody: (droppedInlinePlacements) =>
            renderReviewPointerBody(payload, {
              ...renderCtx,
              mode,
              summaryCommentUrl,
              placements: mergeDroppedIntoSummaryPlacements(placements, droppedInlinePlacements),
              droppedInlinePlacements,
            }).body,
          event,
          commitId: headSha,
          inlinePlacements: inlineFindings,
          renderCommentBody: (finding) => renderInlineThreadBody(finding, renderCtx),
        });
        if (inlineResult.review) {
          inlineReviewId = inlineResult.review.id;
          publishState.inlineReviewId = inlineResult.review.id;
          inlineFindings = inlineResult.postedPlacements;
          anchorDroppedPlacements = inlineResult.anchorDroppedPlacements;
          summaryPlacements = mergeDroppedIntoSummaryPlacements(placements, anchorDroppedPlacements);

          const pointerBody = renderReviewPointerBody(payload, {
            ...renderCtx,
            mode,
            summaryCommentUrl,
            placements: summaryPlacements,
            droppedInlinePlacements: anchorDroppedPlacements,
          });
          if (pointerBody.truncated) {
            logDebug("agent_fix_prompt_truncated", {
              mode,
              owner,
              repo,
              pr: prNumber,
            });
          }
          if (anchorDroppedPlacements.length > 0) {
            logDebug("review_inline_anchor_dropped", {
              mode,
              owner,
              repo,
              pr: prNumber,
              droppedCount: anchorDroppedPlacements.length,
              lineResolutionFallback: inlineResult.lineResolutionFallback,
            });
          }

          const inlinePostedFindings = inlineFindings.map((placement) => placement.finding);
          await params.recordPublishStep?.("inline_review", {
            githubId: inlineResult.review.id,
            meta: {
              url: inlineResult.review.url,
              event,
              agentFixPromptTruncated: pointerBody.truncated,
              fingerprints: inlineReviewFingerprints(inlinePostedFindings),
              droppedInlineCount: anchorDroppedPlacements.length,
              lineResolutionFallback: inlineResult.lineResolutionFallback,
              ...publishMetaBase,
            },
          });
          logDebug("review_published_inline", {
            mode,
            owner,
            repo,
            pr: prNumber,
            reviewId: inlineResult.review.id,
            event,
            inlineCount: inlineFindings.length,
            droppedInlineCount: anchorDroppedPlacements.length,
            agentFixPromptTruncated: pointerBody.truncated,
          });
        } else if (inlineResult.lineResolutionFallback) {
          summaryPlacements = downgradePlacementsAfterInlineFailure(placements);
          await params.recordPublishStep?.("inline_review", {
            meta: {
              reason: "inline_publish_failed",
              lineResolutionFallback: true,
              droppedInlineCount: inlineResult.anchorDroppedPlacements.length,
              fingerprints: inlineReviewFingerprints([]),
              ...publishMetaBase,
            },
          });
          logWarn("review_inline_publish_failed", {
            mode,
            owner,
            repo,
            pr: prNumber,
            message: "All inline anchors rejected after partial drop",
            lineResolution: true,
            droppedInlineCount: inlineResult.anchorDroppedPlacements.length,
            ...publishMetaBase,
          });
        }
      } catch (e) {
        logWarn("review_inline_publish_failed", {
          mode,
          owner,
          repo,
          pr: prNumber,
          message: e instanceof Error ? e.message : String(e),
          lineResolution: false,
          ...publishMetaBase,
        });
        summaryPlacements = downgradePlacementsAfterInlineFailure(placements);
        await params.recordPublishStep?.("inline_review", {
          meta: {
            reason: "inline_publish_failed",
            lineResolutionFallback: false,
            fingerprints: inlineReviewFingerprints([]),
            ...publishMetaBase,
          },
        });
      }
    } else if (params.shouldLinkToSummary && payload.findings.length === 0) {
      const body = renderRepeatNoBugsReviewBody(mode, summaryCommentUrl);
      try {
        const review = await createPullRequestReviewWithComments(token, owner, repo, prNumber, {
          body,
          event: "COMMENT",
          commitId: headSha,
        });
        await params.recordPublishStep?.("inline_review", {
          githubId: review.id,
          meta: {
            url: review.url,
            inlineCount: 0,
            repeatNoBugs: true,
            event: "COMMENT",
            fingerprints: inlineReviewFingerprints([]),
          },
        });
        logDebug("review_published_repeat_no_bugs", {
          mode,
          owner,
          repo,
          pr: prNumber,
          reviewId: review.id,
        });
      } catch (e) {
        logWarn("review_repeat_no_bugs_publish_failed", {
          mode,
          owner,
          repo,
          pr: prNumber,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    } else {
      logDebug("review_inline_skipped", {
        reason: "no_valid_inline_anchors",
        diffCacheEmpty,
        mode,
        owner,
        repo,
        pr: prNumber,
        ...publishMetaBase,
      });
      await params.recordPublishStep?.("inline_review", {
        meta: {
          reason: "no_valid_inline_anchors",
          fingerprints: inlineReviewFingerprints([]),
          ...publishMetaBase,
        },
      });
    }

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
