import type {
  PrConversationComment,
  PrReviewState,
  PrSurface,
  PublishedBatch,
  ThreadBatchReview,
} from "./prSurfaceTypes.ts";

export function prReviewState(value: unknown): PrReviewState {
  switch (value) {
    case "APPROVED":
    case "CHANGES_REQUESTED":
    case "COMMENTED":
    case "DISMISSED":
    case "PENDING":
      return value;
    default:
      return "COMMENTED";
  }
}

export function prReviewStateFromEvent(
  event: ThreadBatchReview["event"],
): Exclude<PrReviewState, "DISMISSED" | "PENDING"> {
  switch (event) {
    case "APPROVE":
      return "APPROVED";
    case "REQUEST_CHANGES":
      return "CHANGES_REQUESTED";
    case "COMMENT":
      return "COMMENTED";
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

export function findCommentIdByMarker<T extends PrConversationComment>(
  comments: readonly T[],
  marker: string,
  predicate?: (comment: T) => boolean,
): number | null {
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const comment = comments[index];
    if (
      comment != null &&
      comment.body.includes(marker) &&
      (predicate == null || predicate(comment))
    ) {
      return comment.id;
    }
  }
  return null;
}

export async function findPublishedThreadBatch(
  surface: Pick<PrSurface, "getBotLogin" | "listPullRequestReviews">,
  marker: string,
  commitId?: string,
): Promise<PublishedBatch | null> {
  const botLogin = await surface.getBotLogin();
  const reviews = await surface.listPullRequestReviews();
  for (let index = reviews.length - 1; index >= 0; index -= 1) {
    const review = reviews[index];
    if (
      review != null &&
      typeof review.body === "string" &&
      review.authorLogin === botLogin &&
      review.body.includes(marker) &&
      (commitId == null || review.commitId === commitId)
    ) {
      return { reviewId: review.id, reviewUrl: review.htmlUrl };
    }
  }
  return null;
}
