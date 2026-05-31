import type { ReviewFinding } from "./reviewSchema.js";
import { isInlineSeverity } from "./reviewSchema.js";
import { compareReviewFindingsBySeverityFileLine } from "./reviewFindingSort.js";
import { resolveInlineAnchorLine, type CachedPrDiffIndex } from "./reviewDiffIndex.js";

export type InlinePlacement = {
  readonly finding: ReviewFinding;
  readonly inlineLine: number | null;
  readonly inlinePosted: boolean;
  /** Set at publish time when the inline thread exists on the Files tab. */
  readonly inlineCommentUrl?: string;
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

/** Stable lookup key for placement ↔ finding within one publish run. */
export function reviewFindingPlacementKey(finding: ReviewFinding): string {
  return `${finding.file}:${finding.startLine}:${finding.endLine}:${finding.severity}:${finding.title}`;
}

export function mergeDroppedIntoSummaryPlacements(
  placements: readonly InlinePlacement[],
  dropped: readonly InlinePlacement[],
): InlinePlacement[] {
  if (dropped.length === 0) return [...placements];
  const droppedByKey = new Map(
    dropped.map((placement) => [reviewFindingPlacementKey(placement.finding), placement]),
  );
  return placements.map(
    (placement) => droppedByKey.get(reviewFindingPlacementKey(placement.finding)) ?? placement,
  );
}
