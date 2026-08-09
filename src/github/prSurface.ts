import { createPrSurfaceImpl } from "./prSurfaceImpl.js";
import type { CreatePrSurfaceParams, PrSurface } from "./prSurfaceTypes.js";

export type {
  AcknowledgementTarget,
  CheckRef,
  CiStatusSnapshot,
  CreatePrSurfaceParams,
  IssueCommentRef,
  PostedReply,
  ProgressCommentUpsert,
  PrSurface,
  PublishedBatch,
  PullRequestHeadResolution,
  ReviewCheckOutcome,
  ThreadBatchReview,
} from "./prSurfaceTypes.js";
export { createFakePrSurface } from "./fakePrSurface.js";
export type { FakePrSurfaceControls, FakePrSurfaceEvent } from "./fakePrSurface.js";

/** Production factory for the PR GitHub surface seam. */
export function createPrSurface(params: CreatePrSurfaceParams): PrSurface {
  return createPrSurfaceImpl(params);
}
