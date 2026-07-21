import type { Config } from "../../config.js";
import { AppError } from "../../errors/appError.js";
import { resolveVerifiedSummaryCommentRef } from "../../github/reviewPublish.js";
import type { CiSummaryAuthor } from "../ci/authorCiSummary.js";
import { prepareReviewPayloadForPublish } from "../findings/findingPipeline.js";
import type { InlinePlacement } from "../placement/reviewDiffPlacement.js";
import type { CachedPrDiffIndex } from "../placement/reviewDiffIndex.js";
import {
  reviewSummarySentinelForMode,
  type ReviewMode,
  type ReviewPayload,
  type ReviewPublishContext,
} from "../reviewSchema.js";
import { publishFindingBatch, type ThreadPublishRunState } from "./publishFindingBatch.js";
import { publishReviewSummaryOnly } from "./publishSummaryOnly.js";
import type { SubmitReviewState } from "./submitReviewTool.js";
import type { RecordPublishStepWithCoordination } from "./summaryCommentCoordination.js";

export {
  attachSummaryCommentCoordination,
  upsertSummaryCommentWithCreationClaim,
} from "./summaryCommentCoordination.js";
export type {
  RecordPublishStepFn,
  RecordPublishStepWithCoordination,
  SummaryCommentCoordination,
} from "./summaryCommentCoordination.js";

export async function publishReview(
  params: ReviewPublishContext & {
    token: string;
    mode?: ReviewMode;
    cfg: Pick<Config, "piModel" | "features">;
    payload: ReviewPayload;
    tokenExpiresAtTs?: number;
    dedupedFindingCount?: number;
    publishState: SubmitReviewState;
    cachedDiffIndex?: CachedPrDiffIndex;
    shouldLinkToSummary?: boolean;
    summaryCommentIdHint?: number | null;
    staleReview?: boolean;
    recordPublishStep?: RecordPublishStepWithCoordination;
    storedInlineFingerprints?: readonly string[];
    inlinePlacements?: readonly InlinePlacement[];
    ciSummaryAuthor?: CiSummaryAuthor;
    shouldAbortPublish?: () => Promise<boolean>;
    publishAbortState?: { staleHead?: boolean };
  },
): Promise<void> {
  const mode = params.mode ?? "review";
  const prepared = prepareReviewPayloadForPublish({
    payload: params.payload,
    mode,
    cachedDiffIndex: params.cachedDiffIndex,
  });
  if (!prepared.ok) {
    throw new AppError({
      code: "review.payload_semantic_validation_failed",
      message: prepared.error,
      context: { anchorFailureCount: prepared.anchorFailures.length },
    });
  }

  const recordPublishStep: RecordPublishStepWithCoordination =
    params.recordPublishStep ?? (async () => undefined);
  const runState: ThreadPublishRunState = {
    postedFingerprints: new Set(params.storedInlineFingerprints ?? []),
    postedInlineCount: params.publishState.postedInlineCount,
    batchCount: 0,
    inlineReviewIds: [...params.publishState.inlineReviewIds],
    acceptedFindings: [],
    partialSpecialists: [],
    summaryPlacements: [],
  };

  let summaryCommentUrl: string | undefined;
  let knownSummaryCommentRef: { id: number; url: string } | null = null;
  if (params.shouldLinkToSummary) {
    const summaryRef = await resolveVerifiedSummaryCommentRef(
      params.token,
      params.owner,
      params.repo,
      params.prNumber,
      reviewSummarySentinelForMode(mode),
      params.summaryCommentIdHint,
      params.tokenExpiresAtTs,
    );
    summaryCommentUrl = summaryRef?.url;
    knownSummaryCommentRef = summaryRef ? { id: summaryRef.id, url: summaryRef.url } : null;
  }

  const batchResult = await publishFindingBatch(prepared.prepared.payload.findings, {
    cfg: params.cfg,
    ctx: params,
    getToken: () => params.token,
    cachedDiffIndex: params.cachedDiffIndex,
    recordPublishStep,
    shouldAbortPublish: params.shouldAbortPublish,
    publishAbortState: params.publishAbortState,
    runState,
    tokenExpiresAtTs: params.tokenExpiresAtTs,
    pointerPayload: prepared.prepared.payload,
    summaryCommentUrl,
    shouldLinkToSummary: params.shouldLinkToSummary,
  });
  if (batchResult.kind === "aborted") {
    params.publishState.publishSuperseded = true;
    throw new AppError({
      code: "review.publish_superseded",
      message: "Review publish skipped: work superseded or cancelled",
      context: { reason: batchResult.reason },
    });
  }

  params.publishState.inlineReviewIds = [...runState.inlineReviewIds];
  params.publishState.postedInlineCount = runState.postedInlineCount;
  await publishReviewSummaryOnly({
    cfg: params.cfg,
    ctx: params,
    getToken: () => params.token,
    getTokenExpiresAtTs: () => params.tokenExpiresAtTs,
    payload: prepared.prepared.payload,
    summaryPlacements: runState.summaryPlacements ?? [],
    inlineReviewIds: runState.inlineReviewIds,
    recordPublishStep,
    ciAuthor: params.ciSummaryAuthor,
    cachedDiffIndex: params.cachedDiffIndex,
    shouldLinkToSummary: params.shouldLinkToSummary,
    summaryCommentIdHint: params.summaryCommentIdHint,
    knownSummaryCommentRef,
    staleReview: params.staleReview,
    shouldAbortPublish: params.shouldAbortPublish,
    publishAbortState: params.publishAbortState,
    publishMeta: {
      dedupedFindingCount: params.dedupedFindingCount ?? prepared.prepared.dedupedCount,
    },
  });
}
