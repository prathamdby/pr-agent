import { isUnfencedSurface, type SurfaceFence } from "../agentWork/writeFence.js";
import { createPrSurfaceImpl } from "./prSurfaceImpl.js";
import { withPrSurfaceMutationBoundary } from "./prSurfaceMutation.js";
import type { CreatePrSurfaceParams, PrSurface } from "./prSurfaceTypes.js";

export type FencedPrSurfaceParams = CreatePrSurfaceParams & {
  readonly mutationBoundary: SurfaceFence;
};

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
export function createPrSurface(params: FencedPrSurfaceParams): PrSurface {
  const mutationBoundary = isUnfencedSurface(params.mutationBoundary)
    ? undefined
    : params.mutationBoundary;
  const { mutationBoundary: _fence, ...rest } = params;
  const surface = createPrSurfaceImpl(rest);
  return mutationBoundary == null
    ? surface
    : withPrSurfaceMutationBoundary(surface, mutationBoundary);
}
