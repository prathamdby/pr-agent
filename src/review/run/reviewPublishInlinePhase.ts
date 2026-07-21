import { createPullRequestReviewWithComments } from "../../github/reviewPublish.js";
import { withTransientReviewRetry } from "../../github/reviewPublishRetry.js";
import { logWarn, logDebug } from "../../evlog.js";
import {
  downgradePlacementsAfterInlineFailure,
  type FingerprintedInlinePlacement,
  mergeDroppedIntoSummaryPlacements,
  type InlinePlacement,
} from "../placement/reviewDiffPlacement.js";
import { publishInlineReviewComments } from "../placement/reviewInlinePublish.js";
import {
  renderInlineThreadBody,
  renderRepeatNoBugsReviewBody,
  renderReviewPointerBody,
} from "./reviewRender.js";
import type { ReviewMode, ReviewPayload } from "../reviewSchema.js";
import type { SubmitReviewState } from "../publish/submitReviewTool.js";

export type InlinePublishPhaseContext = {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  hasDescriptionAgentBlock: boolean;
};

export type InlinePublishPhaseResult = {
  inlineReviewId: number | null;
  summaryPlacements: InlinePlacement[];
  anchorDroppedCount: number;
  lineResolutionFallback: boolean;
  agentFixPromptTruncated: boolean;
};

function buildReviewPointerBody(
  payload: ReviewPayload,
  ctx: InlinePublishPhaseContext & {
    mode: ReviewMode;
    summaryCommentUrl?: string;
    placements: readonly InlinePlacement[];
    droppedInlinePlacements: readonly InlinePlacement[];
  },
): { body: string; truncated: boolean } {
  return renderReviewPointerBody(payload, ctx);
}

export async function runInlinePublishPhase(params: {
  token: string;
  mode: ReviewMode;
  payload: ReviewPayload;
  ctx: InlinePublishPhaseContext;
  placements: readonly FingerprintedInlinePlacement[];
  inlineFindings: readonly FingerprintedInlinePlacement[];
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  summaryCommentUrl?: string;
  shouldLinkToSummary: boolean;
  publishState: SubmitReviewState;
  publishMetaBase: Record<string, unknown>;
  inlineReviewFingerprints: (placements: readonly FingerprintedInlinePlacement[]) => string[];
  tokenExpiresAtTs?: number;
  recordPublishStep?: (
    step: "inline_review",
    detail?: { githubId?: string | number; meta?: Record<string, unknown> },
  ) => Promise<void>;
}): Promise<InlinePublishPhaseResult> {
  const {
    token,
    mode,
    payload,
    ctx,
    placements,
    event,
    summaryCommentUrl,
    publishState,
    publishMetaBase,
    inlineReviewFingerprints,
    tokenExpiresAtTs,
    recordPublishStep,
  } = params;
  let summaryPlacements: InlinePlacement[] = [...params.placements];
  let inlineReviewId = publishState.inlineReviewIds.at(-1) ?? null;
  let anchorDroppedCount = 0;
  let lineResolutionFallback = false;
  let agentFixPromptTruncated = false;
  let inlinePostedPlacements: FingerprintedInlinePlacement[] = [];

  const rememberInlineReviewId = (reviewId: number): void => {
    inlineReviewId = reviewId;
    if (!publishState.inlineReviewIds.includes(reviewId)) {
      publishState.inlineReviewIds.push(reviewId);
    }
  };
  if (params.inlineFindings.length > 0) {
    try {
      let lastPointerTruncated = false;
      const inlineResult = await publishInlineReviewComments(
        token,
        ctx.owner,
        ctx.repo,
        ctx.prNumber,
        {
          renderReviewBody: (droppedInlinePlacements) => {
            const pointerBody = buildReviewPointerBody(payload, {
              ...ctx,
              mode,
              summaryCommentUrl,
              placements: mergeDroppedIntoSummaryPlacements(placements, droppedInlinePlacements),
              droppedInlinePlacements,
            });
            lastPointerTruncated = pointerBody.truncated;
            return pointerBody.body;
          },
          event,
          commitId: ctx.headSha,
          inlinePlacements: params.inlineFindings,
          renderCommentBody: (finding) => renderInlineThreadBody(finding, ctx),
          expiresAtTs: tokenExpiresAtTs,
        },
      );

      if (inlineResult.review) {
        rememberInlineReviewId(inlineResult.review.id);
        summaryPlacements = mergeDroppedIntoSummaryPlacements(
          placements,
          inlineResult.anchorDroppedPlacements,
        );
        anchorDroppedCount = inlineResult.anchorDroppedPlacements.length;
        lineResolutionFallback = inlineResult.lineResolutionFallback;
        inlinePostedPlacements = inlineResult.postedPlacements;

        agentFixPromptTruncated = lastPointerTruncated;
        if (lastPointerTruncated) {
          logDebug("agent_fix_prompt_truncated", {
            mode,
            owner: ctx.owner,
            repo: ctx.repo,
            pr: ctx.prNumber,
          });
        }
        if (anchorDroppedCount > 0) {
          logDebug("review_inline_anchor_dropped", {
            mode,
            owner: ctx.owner,
            repo: ctx.repo,
            pr: ctx.prNumber,
            droppedCount: anchorDroppedCount,
            lineResolutionFallback,
          });
        }

        await recordPublishStep?.("inline_review", {
          githubId: inlineResult.review.id,
          meta: {
            url: inlineResult.review.url,
            event,
            agentFixPromptTruncated,
            fingerprints: inlineReviewFingerprints(inlinePostedPlacements),
            droppedInlineCount: anchorDroppedCount,
            lineResolutionFallback,
            ...publishMetaBase,
          },
        });
        logDebug("review_published_inline", {
          mode,
          owner: ctx.owner,
          repo: ctx.repo,
          pr: ctx.prNumber,
          reviewId: inlineResult.review.id,
          event,
          inlineCount: inlinePostedPlacements.length,
          droppedInlineCount: anchorDroppedCount,
          agentFixPromptTruncated,
        });
      } else if (inlineResult.lineResolutionFallback) {
        lineResolutionFallback = true;
        anchorDroppedCount = inlineResult.anchorDroppedPlacements.length;
        summaryPlacements = downgradePlacementsAfterInlineFailure(placements);
        await recordPublishStep?.("inline_review", {
          meta: {
            reason: "inline_publish_failed",
            lineResolutionFallback: true,
            droppedInlineCount: anchorDroppedCount,
            fingerprints: inlineReviewFingerprints([]),
            ...publishMetaBase,
          },
        });
        logWarn("review_inline_publish_failed", {
          mode,
          owner: ctx.owner,
          repo: ctx.repo,
          pr: ctx.prNumber,
          message: "All inline anchors rejected after partial drop",
          lineResolution: true,
          droppedInlineCount: anchorDroppedCount,
          ...publishMetaBase,
        });
      } else {
        await recordPublishStep?.("inline_review", {
          meta: {
            reason: "no_valid_inline_anchors",
            lineResolutionFallback: false,
            fingerprints: inlineReviewFingerprints([]),
            ...publishMetaBase,
          },
        });
        logDebug("review_inline_skipped", {
          reason: "no_valid_inline_anchors_after_filter",
          mode,
          owner: ctx.owner,
          repo: ctx.repo,
          pr: ctx.prNumber,
          ...publishMetaBase,
        });
      }
    } catch (e) {
      logWarn("review_inline_publish_failed", {
        mode,
        owner: ctx.owner,
        repo: ctx.repo,
        pr: ctx.prNumber,
        message: e instanceof Error ? e.message : String(e),
        lineResolution: false,
        ...publishMetaBase,
      });
      summaryPlacements = downgradePlacementsAfterInlineFailure(placements);
      await recordPublishStep?.("inline_review", {
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
      const reviewParams = {
        body,
        event: "COMMENT" as const,
        commitId: ctx.headSha,
      };
      const review = await withTransientReviewRetry(() =>
        createPullRequestReviewWithComments(
          token,
          ctx.owner,
          ctx.repo,
          ctx.prNumber,
          reviewParams,
          tokenExpiresAtTs,
        ),
      );
      rememberInlineReviewId(review.id);
      await recordPublishStep?.("inline_review", {
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
        owner: ctx.owner,
        repo: ctx.repo,
        pr: ctx.prNumber,
        reviewId: review.id,
      });
    } catch (e) {
      logWarn("review_repeat_no_bugs_publish_failed", {
        mode,
        owner: ctx.owner,
        repo: ctx.repo,
        pr: ctx.prNumber,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  } else {
    logDebug("review_inline_skipped", {
      reason: "no_valid_inline_anchors",
      mode,
      owner: ctx.owner,
      repo: ctx.repo,
      pr: ctx.prNumber,
      ...publishMetaBase,
    });
    await recordPublishStep?.("inline_review", {
      meta: {
        reason: "no_valid_inline_anchors",
        fingerprints: inlineReviewFingerprints([]),
        ...publishMetaBase,
      },
    });
  }

  return {
    inlineReviewId,
    summaryPlacements,
    anchorDroppedCount,
    lineResolutionFallback,
    agentFixPromptTruncated,
  };
}
