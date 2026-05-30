import type { PublishedReviewComment } from "../../github/reviewPublish.js";
import type { InlinePlacement } from "../reviewDiffPlacement.js";

function reviewCommentAnchorKey(path: string, line: number): string {
  return `${path}:${line}`;
}

/** Match GitHub review comments to inline placements in placement order (FIFO per anchor). */
export function enrichPlacementsWithInlineCommentUrls(
  placements: readonly InlinePlacement[],
  comments: readonly PublishedReviewComment[],
): InlinePlacement[] {
  const commentsByAnchor = new Map<string, PublishedReviewComment[]>();
  for (const comment of comments) {
    const key = reviewCommentAnchorKey(comment.path, comment.line);
    const bucket = commentsByAnchor.get(key) ?? [];
    bucket.push(comment);
    commentsByAnchor.set(key, bucket);
  }

  const anchorUseIndex = new Map<string, number>();

  return placements.map((placement) => {
    if (!placement.inlinePosted || placement.inlineLine == null) return placement;
    const key = reviewCommentAnchorKey(placement.finding.file, placement.inlineLine);
    const bucket = commentsByAnchor.get(key);
    if (!bucket || bucket.length === 0) return placement;
    const index = anchorUseIndex.get(key) ?? 0;
    const comment = bucket[index];
    if (!comment) return placement;
    anchorUseIndex.set(key, index + 1);
    return { ...placement, inlineCommentUrl: comment.url };
  });
}
