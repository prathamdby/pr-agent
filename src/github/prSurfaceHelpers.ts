import type { PrConversationComment } from "./prSurfaceTypes.js";

export function findCommentIdByMarker(
  comments: readonly PrConversationComment[],
  marker: string,
  predicate?: (comment: PrConversationComment) => boolean,
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
