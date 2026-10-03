import type { PrConversationComment, PrSurface, PublishedBatch } from "./prSurfaceTypes.js";

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

/** Find the newest bot-authored review carrying an exact hidden operation marker. */
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
