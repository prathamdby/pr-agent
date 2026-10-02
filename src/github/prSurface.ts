import { createPrSurfaceImpl } from "./prSurfaceImpl.js";
import { withPrSurfaceMutationBoundary } from "./prSurfaceMutation.js";
import type { CreatePrSurfaceParams, PrSurface } from "./prSurfaceTypes.js";

export type {
  AcknowledgementTarget,
  CheckRef,
  CiStatusSnapshot,
  CreatePrSurfaceParams,
  GithubUserProfile,
  IssueCommentRef,
  ListReviewCommentsResult,
  PostedReply,
  PrConversationComment,
  PrReview,
  PrReviewComment,
  ProgressCommentUpsert,
  PrSurface,
  PrSurfaceMutation,
  PrSurfaceMutationMethods,
  PrSurfaceMutationBoundary,
  PrSurfaceReadMethods,
  PublishedBatch,
  PullRequestHeadResolution,
  PullRequestUpdate,
  PushedCommitSummary,
  ReviewCheckOutcome,
  ReviewCommitStatusParams,
  ThreadBatchReview,
} from "./prSurfaceTypes.js";
export { createFakePrSurface } from "./fakePrSurface.js";
export type { FakePrSurfaceControls, FakePrSurfaceEvent } from "./fakePrSurface.js";
export { withPrSurfaceMutationBoundary } from "./prSurfaceMutation.js";

/** Production factory for the PR GitHub surface seam. */
export function createPrSurface(params: CreatePrSurfaceParams): PrSurface {
  const surface = createPrSurfaceImpl(params);
  return params.mutationBoundary == null
    ? surface
    : withPrSurfaceMutationBoundary(surface, params.mutationBoundary);
}
