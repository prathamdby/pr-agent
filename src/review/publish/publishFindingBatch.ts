import type { Config } from "../../config.js";
import { AppError } from "../../errors/appError.js";
import { logWarn } from "../../evlog.js";
import { createPullRequestReviewWithComments } from "../../github/reviewPublish.js";
import { withTransientReviewRetry } from "../../github/reviewPublishRetry.js";
import { publishInlineReviewComments } from "../placement/reviewInlinePublish.js";
import {
  downgradePlacementsAfterInlineFailure,
  mergeDroppedIntoSummaryPlacements,
  type InlinePlacement,
} from "../placement/reviewDiffPlacement.js";
import type { CachedPrDiffIndex } from "../placement/reviewDiffIndex.js";
import {
  prepareFindingsForPublish,
  prepareReviewPayloadForPublish,
} from "../findings/findingPipeline.js";
import { fingerprintFinding } from "../findings/reviewFindingFingerprint.js";
import {
  renderInlineThreadBody,
  renderRepeatNoBugsReviewBody,
  renderReviewPointerBody,
} from "../run/reviewRender.js";
import type { ReviewFinding, ReviewPayload, ReviewPublishContext } from "../reviewSchema.js";
import { MAX_INLINE_REVIEW_COMMENTS, MAX_THREAD_PUBLISH_CALLS } from "../../settings/index.js";
import type { RecordPublishStepWithCoordination } from "./summaryCommentCoordination.js";

export type ThreadPublishRunState = {
  postedFingerprints: Set<string>;
  postedInlineCount: number;
  batchCount: number;
  inlineReviewIds: number[];
  acceptedFindings: ReviewFinding[];
  partialSpecialists: string[];
  /** Accumulated publish placements used by the V1 composition path. */
  summaryPlacements?: InlinePlacement[];
};

export type FindingBatchContext = {
  cfg: Pick<Config, "piModel" | "features">;
  ctx: ReviewPublishContext;
  getToken: () => string;
  cachedDiffIndex?: CachedPrDiffIndex;
  recordPublishStep: RecordPublishStepWithCoordination;
  shouldAbortPublish?: () => Promise<boolean>;
  publishAbortState?: { staleHead?: boolean };
  runState: ThreadPublishRunState;
  tokenExpiresAtTs?: number;
  pointerPayload?: ReviewPayload;
  summaryCommentUrl?: string;
  shouldLinkToSummary?: boolean;
};

export type FindingBatchResult =
  | {
      kind: "published";
      reviewId: number;
      posted: number;
      suppressed: number;
      dropped: number;
    }
  | { kind: "empty" }
  | { kind: "aborted"; reason: "stale_head" | "superseded" }
  | { kind: "budget_exhausted" };

function batchReviewPayload(findings: ReviewFinding[]): ReviewPayload {
  return {
    prCharacter: "Incremental review findings.",
    findings,
    estimatedEffort: 1,
    relevantTests: "no",
    securityConcerns: null,
    followUps: [],
  };
}

function appendAcceptedFindings(
  runState: ThreadPublishRunState,
  findings: readonly ReviewFinding[],
): void {
  const existing = new Set(
    runState.acceptedFindings.map((finding) => fingerprintFinding(finding, "review")),
  );
  for (const finding of findings) {
    const fingerprint = fingerprintFinding(finding, "review");
    if (existing.has(fingerprint)) continue;
    existing.add(fingerprint);
    runState.acceptedFindings.push(finding);
  }
}

function appendSummaryPlacements(
  runState: ThreadPublishRunState,
  placements: readonly InlinePlacement[],
): void {
  if (runState.summaryPlacements == null) runState.summaryPlacements = [];
  runState.summaryPlacements.push(...placements);
}

async function abortReason(
  context: FindingBatchContext,
): Promise<"stale_head" | "superseded" | null> {
  if (!context.shouldAbortPublish) return null;
  try {
    if (!(await context.shouldAbortPublish())) return null;
  } catch (error) {
    logWarn("review_thread_batch_abort_check_failed", {
      owner: context.ctx.owner,
      repo: context.ctx.repo,
      pr: context.ctx.prNumber,
      message: error instanceof Error ? error.message : String(error),
    });
    return "superseded";
  }
  return context.publishAbortState?.staleHead === true ? "stale_head" : "superseded";
}

export async function publishFindingBatch(
  batch: readonly ReviewFinding[],
  context: FindingBatchContext,
): Promise<FindingBatchResult> {
  const prepared = prepareReviewPayloadForPublish({
    payload: batchReviewPayload([...batch]),
    mode: "review",
    cachedDiffIndex: context.cachedDiffIndex,
  });
  if (!prepared.ok) {
    throw new AppError({
      code: "review.finding_batch_validation_failed",
      message: prepared.error,
      context: { anchorFailureCount: prepared.anchorFailures.length },
    });
  }

  const remainingInlineCapacity = Math.max(
    0,
    MAX_INLINE_REVIEW_COMMENTS - context.runState.postedInlineCount,
  );
  const targets = prepareFindingsForPublish({
    payload: prepared.prepared.payload,
    mode: "review",
    cachedDiffIndex: context.cachedDiffIndex,
    inlinePlacements: prepared.prepared.placements,
    storedInlineFingerprints: [...context.runState.postedFingerprints],
    maxInlineComments: remainingInlineCapacity,
  });

  const abort = await abortReason(context);
  if (abort != null) return { kind: "aborted", reason: abort };

  if (context.runState.batchCount >= MAX_THREAD_PUBLISH_CALLS) {
    appendAcceptedFindings(context.runState, prepared.prepared.payload.findings);
    appendSummaryPlacements(
      context.runState,
      downgradePlacementsAfterInlineFailure(targets.placements),
    );
    return { kind: "budget_exhausted" };
  }

  context.runState.batchCount += 1;
  appendAcceptedFindings(context.runState, prepared.prepared.payload.findings);

  if (targets.inline.length === 0) {
    appendSummaryPlacements(context.runState, targets.placements);
    if (batch.length === 0 && context.shouldLinkToSummary && context.summaryCommentUrl != null) {
      let review;
      try {
        review = await withTransientReviewRetry(() =>
          createPullRequestReviewWithComments(
            context.getToken(),
            context.ctx.owner,
            context.ctx.repo,
            context.ctx.prNumber,
            {
              body: renderRepeatNoBugsReviewBody("review", context.summaryCommentUrl),
              event: "COMMENT",
              commitId: context.ctx.headSha,
            },
            context.tokenExpiresAtTs,
          ),
        );
      } catch (error) {
        logWarn("review_repeat_no_bugs_publish_failed", {
          owner: context.ctx.owner,
          repo: context.ctx.repo,
          pr: context.ctx.prNumber,
          message: error instanceof Error ? error.message : String(error),
        });
        return { kind: "empty" };
      }

      try {
        await context.recordPublishStep("inline_review", {
          githubId: review.id,
          meta: {
            batches: [
              {
                reviewId: review.id,
                fingerprints: [],
                event: "COMMENT",
                url: review.url,
                counts: { posted: 0, suppressed: 0, dropped: 0 },
                repeatNoBugs: true,
              },
            ],
          },
        });
      } catch (error) {
        throw new AppError({
          code: "review.finding_batch_record_failed",
          message: "Durable repeat-no-bugs review batch record failed after GitHub publish",
          context: {
            owner: context.ctx.owner,
            repo: context.ctx.repo,
            pr: context.ctx.prNumber,
            reviewId: review.id,
          },
          cause: error,
        });
      }

      if (!context.runState.inlineReviewIds.includes(review.id)) {
        context.runState.inlineReviewIds.push(review.id);
      }
      return {
        kind: "published",
        reviewId: review.id,
        posted: 0,
        suppressed: 0,
        dropped: 0,
      };
    }
    return { kind: "empty" };
  }

  const pointerPayload = context.pointerPayload ?? prepared.prepared.payload;
  let result;
  try {
    result = await publishInlineReviewComments(
      context.getToken(),
      context.ctx.owner,
      context.ctx.repo,
      context.ctx.prNumber,
      {
        renderReviewBody: (anchorDroppedPlacements) =>
          renderReviewPointerBody(pointerPayload, {
            ...context.ctx,
            mode: "review",
            summaryCommentUrl: context.summaryCommentUrl,
            placements: mergeDroppedIntoSummaryPlacements(
              targets.placements,
              anchorDroppedPlacements,
            ),
            droppedInlinePlacements: anchorDroppedPlacements,
          }).body,
        event: "COMMENT",
        commitId: context.ctx.headSha,
        inlinePlacements: targets.inline,
        renderCommentBody: (item) => renderInlineThreadBody(item, context.ctx),
        expiresAtTs: context.tokenExpiresAtTs,
      },
    );
  } catch (error) {
    logWarn("review_inline_publish_failed", {
      owner: context.ctx.owner,
      repo: context.ctx.repo,
      pr: context.ctx.prNumber,
      message: error instanceof Error ? error.message : String(error),
      lineResolution: false,
    });
    appendSummaryPlacements(
      context.runState,
      downgradePlacementsAfterInlineFailure(targets.placements),
    );
    return { kind: "empty" };
  }

  const summaryPlacements = mergeDroppedIntoSummaryPlacements(
    targets.placements,
    result.anchorDroppedPlacements,
  );
  appendSummaryPlacements(context.runState, summaryPlacements);
  if (!result.review) return { kind: "empty" };

  const fingerprints = result.postedPlacements.map((placement) => placement.inlineFingerprint);
  const dropped = targets.dropped.inlineCommentCapExcluded + result.anchorDroppedPlacements.length;
  const counts = {
    posted: result.postedPlacements.length,
    suppressed: targets.dropped.suppressedInlineCount,
    dropped,
  };
  try {
    await context.recordPublishStep("inline_review", {
      githubId: result.review.id,
      meta: {
        batches: [
          {
            reviewId: result.review.id,
            fingerprints,
            event: "COMMENT",
            url: result.review.url,
            counts,
          },
        ],
      },
    });
  } catch (error) {
    throw new AppError({
      code: "review.finding_batch_record_failed",
      message: "Durable inline review batch record failed after GitHub publish",
      context: {
        owner: context.ctx.owner,
        repo: context.ctx.repo,
        pr: context.ctx.prNumber,
        reviewId: result.review.id,
      },
      cause: error,
    });
  }

  for (const fingerprint of fingerprints) {
    context.runState.postedFingerprints.add(fingerprint);
  }
  context.runState.postedInlineCount += result.postedPlacements.length;
  if (!context.runState.inlineReviewIds.includes(result.review.id)) {
    context.runState.inlineReviewIds.push(result.review.id);
  }

  return {
    kind: "published",
    reviewId: result.review.id,
    ...counts,
  };
}
