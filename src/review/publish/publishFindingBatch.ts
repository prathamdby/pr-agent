import type { Config } from "../../config.js";
import { AppError } from "../../errors/appError.js";
import { logWarn } from "../../evlog.js";
import { publishInlineReviewComments } from "../placement/reviewInlinePublish.js";
import {
  downgradePlacementsAfterInlineFailure,
  mergeDroppedIntoSummaryPlacements,
} from "../placement/reviewDiffPlacement.js";
import type { CachedPrDiffIndex } from "../placement/reviewDiffIndex.js";
import {
  prepareFindingsForPublish,
  prepareReviewPayloadForPublish,
} from "../findings/findingPipeline.js";
import type { InstallationTokenHandle } from "../../github/installationTokenHandle.js";
import {
  MAX_INLINE_REVIEW_COMMENTS,
  MAX_THREAD_PUBLISH_CALLS,
  REVIEW_PUBLISH_TRANSIENT_RETRY_DELAYS_MS,
} from "../../settings/index.js";
import { renderInlineThreadBody, renderReviewPointerBody } from "../run/reviewRender.js";
import type { ReviewFinding, ReviewPayload, ReviewPublishContext } from "../reviewSchema.js";
import type { PublishAbortGate } from "./publishAbortGate.js";
import type { RecordPublishStepWithCoordination } from "./summaryCommentCoordination.js";
import {
  appendAcceptedFindings,
  appendSummaryPlacements,
  type ThreadPublishRunState,
} from "./threadPublishRunState.js";

export type { ThreadPublishRunState };

export type FindingBatchContext = {
  cfg: Pick<Config, "piModel" | "features">;
  ctx: ReviewPublishContext;
  token: InstallationTokenHandle;
  cachedDiffIndex?: CachedPrDiffIndex;
  recordPublishStep: RecordPublishStepWithCoordination;
  abortGate: PublishAbortGate;
  runState: ThreadPublishRunState;
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

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Durable append after GitHub already accepted the review. Retries with the same bounded
 * schedule as other publish writes. Cross-process duplicate prevention still requires the
 * durable row — in-memory fingerprints only stop same-run model repair from reposting.
 */
async function recordInlineBatchWithRetry(
  context: FindingBatchContext,
  detail: { githubId: number; meta: Record<string, unknown> },
  failureMessage: string,
): Promise<void> {
  const delays = REVIEW_PUBLISH_TRANSIENT_RETRY_DELAYS_MS;
  let lastError: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      await context.recordPublishStep("inline_review", detail);
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= delays.length) break;
      const delay = delays[attempt];
      if (delay != null) await sleepMs(delay);
    }
  }
  throw new AppError({
    code: "review.finding_batch_record_failed",
    message: failureMessage,
    context: {
      owner: context.ctx.owner,
      repo: context.ctx.repo,
      pr: context.ctx.prNumber,
      reviewId: detail.githubId,
    },
    cause: lastError,
  });
}

async function abortReason(
  context: FindingBatchContext,
): Promise<"stale_head" | "superseded" | null> {
  let kind: "continue" | "stale_head" | "superseded";
  try {
    kind = await context.abortGate();
  } catch (error) {
    logWarn("review_thread_batch_abort_check_failed", {
      owner: context.ctx.owner,
      repo: context.ctx.repo,
      pr: context.ctx.prNumber,
      message: error instanceof Error ? error.message : String(error),
    });
    return "superseded";
  }
  if (kind === "continue") return null;
  return kind;
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
    return { kind: "empty" };
  }

  await context.token.refreshNearExpiry();
  let result;
  try {
    result = await publishInlineReviewComments(
      context.token.getToken(),
      context.ctx.owner,
      context.ctx.repo,
      context.ctx.prNumber,
      {
        renderReviewBody: (anchorDroppedPlacements) =>
          renderReviewPointerBody(prepared.prepared.payload, {
            ...context.ctx,
            mode: "review",
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
        expiresAtTs: context.token.getExpiresAtTs(),
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

  // Latch in-memory before durable append so a same-run repair cannot repost.
  for (const fingerprint of fingerprints) {
    context.runState.postedFingerprints.add(fingerprint);
  }
  context.runState.postedInlineCount += result.postedPlacements.length;
  if (!context.runState.inlineReviewIds.includes(result.review.id)) {
    context.runState.inlineReviewIds.push(result.review.id);
  }

  await recordInlineBatchWithRetry(
    context,
    {
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
    },
    "Durable inline review batch record failed after GitHub publish",
  );

  return {
    kind: "published",
    reviewId: result.review.id,
    ...counts,
  };
}
