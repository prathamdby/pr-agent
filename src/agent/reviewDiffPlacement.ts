import type { ReviewFinding } from "./reviewSchema.js";
import { isInlineSeverity } from "./reviewSchema.js";
import { compareReviewFindingsBySeverityFileLine } from "./reviewFindingSort.js";
import {
  createCachedPrDiffIndex,
  ingestListPullRequestFilesResult,
  renderAnchorMenuBlock,
  resolveInlineAnchorLine,
  wrapListPullRequestFilesDiffIngestion,
  type CachedPrDiffIndex,
} from "./reviewDiffIndex.js";

export type InlinePlacement = {
  readonly finding: ReviewFinding;
  readonly inlineLine: number | null;
  readonly inlinePosted: boolean;
  /** Set at publish time when the inline thread exists on the Files tab. */
  readonly inlineCommentUrl?: string;
};

export {
  createCachedPrDiffIndex,
  ingestListPullRequestFilesResult,
  renderAnchorMenuBlock,
  wrapListPullRequestFilesDiffIngestion,
  type CachedPrDiffIndex,
};

export function planInlinePlacements(
  findings: ReviewFinding[],
  diffIndex: CachedPrDiffIndex | undefined,
): InlinePlacement[] {
  return findings.map((finding) => {
    if (!isInlineSeverity(finding.severity)) {
      return { finding, inlineLine: null, inlinePosted: false };
    }
    const inlineLine = resolveInlineAnchorLine(
      diffIndex,
      finding.file,
      finding.startLine,
      finding.endLine,
    );
    return {
      finding,
      inlineLine,
      inlinePosted: inlineLine != null,
    };
  });
}

export function applyInlineCommentCap(
  placements: readonly InlinePlacement[],
  maxInlineComments: number,
): { placements: InlinePlacement[]; inlineCommentCapExcluded: number } {
  const posted = placements
    .map((placement, index) => ({ placement, index }))
    .filter(({ placement }) => placement.inlinePosted);

  if (posted.length <= maxInlineComments) {
    return { placements: [...placements], inlineCommentCapExcluded: 0 };
  }

  const keepIndices = new Set(
    posted
      .toSorted((a, b) =>
        compareReviewFindingsBySeverityFileLine(a.placement.finding, b.placement.finding),
      )
      .slice(0, maxInlineComments)
      .map(({ index }) => index),
  );

  let inlineCommentCapExcluded = 0;
  const capped = placements.map((placement, index) => {
    if (!placement.inlinePosted || keepIndices.has(index)) {
      return placement;
    }
    inlineCommentCapExcluded++;
    return { ...placement, inlinePosted: false };
  });

  return { placements: capped, inlineCommentCapExcluded };
}

export function downgradePlacementsAfterInlineFailure(
  placements: readonly InlinePlacement[],
): InlinePlacement[] {
  return placements.map((placement) =>
    placement.inlinePosted ? { ...placement, inlinePosted: false } : placement,
  );
}

export function isLineResolutionPublishError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /line could not be resolved/i.test(message) ||
    /pull request review thread line.*invalid/i.test(message) ||
    /must be part of the diff/i.test(message)
  );
}
