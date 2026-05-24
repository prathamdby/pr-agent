import type { Config } from "../config.js";
import {
  createPullRequestReviewWithComments,
  enrichPlacementsWithInlineCommentUrls,
  listPullRequestLabels,
  listPullRequestReviewCommentsForReview,
  resolveVerifiedSummaryCommentUrl,
  setPullRequestLabels,
  upsertReviewSummaryComment,
  type InlineReviewComment,
} from "../github/reviewPublish.js";
import { labelsAlreadySynced, reviewLabelsFromPayload, syncReviewLabels } from "./reviewLabels.js";
import { logWarn, logDebug } from "../evlog.js";
import {
  renderInlineThreadBody,
  renderRepeatNoBugsReviewBody,
  renderReviewPointerBody,
  renderReviewSummaryComment,
} from "./reviewRender.js";
import {
  downgradePlacementsAfterInlineFailure,
  isLineResolutionPublishError,
  planInlinePlacements,
  type CachedPrDiffIndex,
} from "./reviewLocationValidation.js";
import {
  mergeInlineFingerprintRecords,
  suppressInlinePlacementsByFingerprint,
} from "./reviewFindingFingerprint.js";
import {
  reviewEventForFindings,
  reviewSummarySentinelForMode,
  type ReviewFinding,
  type ReviewMode,
  type ReviewPayload,
  type ReviewPublishContext,
} from "./reviewSchema.js";
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
    cfg: Pick<
      Config,
      "maxReviewFindings" | "enableReviewLabelsEffort" | "enableReviewLabelsSecurity"
    >;
    payload: ReviewPayload;
    /** Set when payload was already normalized, deduped, and validated by submitReview. */
    dedupedFindingCount?: number;
    publishState: SubmitReviewState;
    cachedDiffIndex?: CachedPrDiffIndex;
    shouldLinkToSummary?: boolean;
    summaryCommentIdHint?: number | null;
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

  let placements = planInlinePlacements(
    payload.findings,
    cfg.maxReviewFindings,
    params.cachedDiffIndex,
  );
  const suppression = suppressInlinePlacementsByFingerprint(
    placements,
    mode,
    storedInlineFingerprints,
  );
  placements = suppression.placements;
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
    maxFindings: cfg.maxReviewFindings,
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
    severityCapExcluded: placements.filter(
      (p) => !p.inlineCapEligible && p.inlineLine == null && p.finding.severity !== "P3",
    ).length,
    anchorUnresolved: placements.filter((p) => p.inlineCapEligible && p.inlineLine == null).length,
    dedupedFindingCount: params.dedupedFindingCount ?? 0,
    suppressedInlineCount: suppression.suppressedInlineCount,
  };

  if (!publishState.inlinePublished) {
    const comments: InlineReviewComment[] = inlineFindings.map((p) => ({
      path: p.finding.file,
      line: p.inlineLine!,
      side: "RIGHT" as const,
      body: renderInlineThreadBody(p.finding, renderCtx),
    }));

    if (comments.length > 0) {
      const pointerBody = renderReviewPointerBody(payload, {
        ...renderCtx,
        mode,
        summaryCommentUrl,
        placements,
      });
      if (pointerBody.truncated) {
        logDebug("agent_fix_prompt_truncated", {
          mode,
          owner,
          repo,
          pr: prNumber,
        });
      }
      try {
        const review = await createPullRequestReviewWithComments(token, owner, repo, prNumber, {
          body: pointerBody.body,
          event,
          comments,
          commitId: headSha,
        });
        inlineReviewId = review.id;
        publishState.inlineReviewId = review.id;
        const inlinePostedFindings = inlineFindings.map((placement) => placement.finding);
        await params.recordPublishStep?.("inline_review", {
          githubId: review.id,
          meta: {
            url: review.url,
            event,
            agentFixPromptTruncated: pointerBody.truncated,
            fingerprints: inlineReviewFingerprints(inlinePostedFindings),
            ...publishMetaBase,
          },
        });
        logDebug("review_published_inline", {
          mode,
          owner,
          repo,
          pr: prNumber,
          reviewId: review.id,
          event,
          inlineCount: comments.length,
        });
      } catch (e) {
        logWarn("review_inline_publish_failed", {
          mode,
          owner,
          repo,
          pr: prNumber,
          message: e instanceof Error ? e.message : String(e),
          lineResolution: isLineResolutionPublishError(e),
          ...publishMetaBase,
        });
        summaryPlacements = downgradePlacementsAfterInlineFailure(placements);
        await params.recordPublishStep?.("inline_review", {
          meta: {
            reason: "inline_publish_failed",
            lineResolutionFallback: isLineResolutionPublishError(e),
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
      summaryPlacements = enrichPlacementsWithInlineCommentUrls(
        summaryPlacements,
        reviewComments,
      );
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
