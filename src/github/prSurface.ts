import { isUnfencedSurface, type SurfaceFence } from "../agentWork/writeFence.ts";
import { createPrSurfaceImpl } from "./prSurfaceImpl.ts";
import { withPrSurfaceMutationBoundary } from "./prSurfaceMutation.ts";
import type { CreatePrSurfaceParams, PrSurface } from "./prSurfaceTypes.ts";

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
} from "./prSurfaceTypes.ts";
export { createFakePrSurface } from "./fakePrSurface.ts";
export type { FakePrSurfaceControls, FakePrSurfaceEvent } from "./fakePrSurface.ts";
export { withPrSurfaceMutationBoundary } from "./prSurfaceMutation.ts";

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
