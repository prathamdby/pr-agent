import type {
  PrConversationComment,
  PrReviewState,
  PrSurface,
  PublishedBatch,
  ThreadBatchReview,
} from "./prSurfaceTypes.ts";

export function prReviewState(value: unknown) {
  switch (value) {
    case "APPROVED":
    case "CHANGES_REQUESTED":
    case "COMMENTED":
    case "DISMISSED":
    case "PENDING":
      return ((pinnedReturn: PrReviewState) => pinnedReturn)(value);
    default:
      return ((pinnedReturn: PrReviewState) => pinnedReturn)("COMMENTED");
  }
}

export function prReviewStateFromEvent(event: ThreadBatchReview["event"]) {
  switch (event) {
    case "APPROVE":
      return ((pinnedReturn: Exclude<PrReviewState, "DISMISSED" | "PENDING">) => pinnedReturn)(
        "APPROVED",
      );
    case "REQUEST_CHANGES":
      return ((pinnedReturn: Exclude<PrReviewState, "DISMISSED" | "PENDING">) => pinnedReturn)(
        "CHANGES_REQUESTED",
      );
    case "COMMENT":
      return ((pinnedReturn: Exclude<PrReviewState, "DISMISSED" | "PENDING">) => pinnedReturn)(
        "COMMENTED",
      );
    default: {
      const _exhaustive: never = event;
      return ((pinnedReturn: Exclude<PrReviewState, "DISMISSED" | "PENDING">) => pinnedReturn)(
        _exhaustive,
      );
    }
  }
}

export function findCommentIdByMarker<T extends PrConversationComment>(
  comments: readonly T[],
  marker: string,
  predicate?: (comment: T) => boolean,
) {
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const comment = comments[index];
    if (
      comment != null &&
      comment.body.includes(marker) &&
      (predicate == null || predicate(comment))
    ) {
      return ((pinnedReturn: number | null) => pinnedReturn)(comment.id);
    }
  }
  return ((pinnedReturn: number | null) => pinnedReturn)(null);
}

export async function findPublishedThreadBatch(
  surface: Pick<PrSurface, "getBotLogin" | "listPullRequestReviews">,
  marker: string,
  commitId?: string,
) {
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
      return ((pinnedReturn: (PublishedBatch | null) | Promise<PublishedBatch | null>) =>
        pinnedReturn)({ reviewId: review.id, reviewUrl: review.htmlUrl });
    }
  }
  return ((pinnedReturn: (PublishedBatch | null) | Promise<PublishedBatch | null>) => pinnedReturn)(
    null,
  );
}
