import { createPrSurfaceImpl } from "./prSurfaceImpl.js";
import type { CreatePrSurfaceParams, PrSurface } from "./prSurfaceTypes.js";

export type {
  AcknowledgementTarget,
  CheckRef,
  CiStatusSnapshot,
  CreatePrSurfaceParams,
  GithubUserProfile,
  IssueCommentRef,
  ListPullRequestReviewCommentsResult,
  PostedReply,
  PriorInlineFeedbackEntry,
  ReviewCommentParentNode,
  PrConversationComment,
  ProgressCommentUpsert,
  PrSurface,
  PublishDescriptionSurfaceResult,
  PublishedBatch,
  PublishedReviewCommentRef,
  PullRequestBranchInfo,
  PullRequestHeadResolution,
  PushedCommitSummary,
  ReviewCheckOutcome,
  ReviewCommitStatusParams,
  ThreadBatchReview,
} from "./prSurfaceTypes.js";
export { createFakePrSurface } from "./fakePrSurface.js";
export type { FakePrSurfaceControls, FakePrSurfaceEvent } from "./fakePrSurface.js";

export type CreatePrSurface = (params: CreatePrSurfaceParams) => PrSurface;

let activeCreatePrSurface: CreatePrSurface = createPrSurfaceImpl;

export function setCreatePrSurface(create: CreatePrSurface): void {
  activeCreatePrSurface = create;
}

export function resetCreatePrSurface(): void {
  activeCreatePrSurface = createPrSurfaceImpl;
}

/** Production factory for the PR GitHub surface seam. */
export function createPrSurface(params: CreatePrSurfaceParams): PrSurface {
  return activeCreatePrSurface(params);
}
