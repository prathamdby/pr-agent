import type { ReviewFinding } from "../reviewSchema.ts";
import { isInlineSeverity } from "../reviewSchema.ts";
import type { FindingId } from "../findingIdentity/findingMarker.ts";
import { compareReviewFindingsBySeverityFileLine } from "../findings/reviewFindingSort.ts";
import {
  resolveInlineAnchorLine,
  type CachedPrDiffIndex,
} from "../../prWorkspace/reviewDiffIndex.ts";

export type InlinePlacement = {
  readonly finding: ReviewFinding;
  readonly inlineLine: number | null;
  readonly inlinePosted: boolean;
  readonly inlineCommentUrl?: string;
};

export type IdentifiedInlinePlacement = InlinePlacement & {
  readonly findingId: FindingId;
  readonly reopens?: FindingId;
  readonly relatedLinks?: readonly string[];
};

export function planInlinePlacements(
  findings: ReviewFinding[],
  diffIndex: CachedPrDiffIndex | undefined,
) {
  return ((pinnedReturn: InlinePlacement[]) => pinnedReturn)(
    findings.map((finding) => {
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
    }),
  );
}

export function applyInlineCommentCap<TPlacement extends InlinePlacement>(
  placements: readonly TPlacement[],
  maxInlineComments: number,
) {
  const posted = placements
    .map((placement, index) => ({ placement, index }))
    .filter(({ placement }) => placement.inlinePosted);

  if (posted.length <= maxInlineComments) {
    return ((pinnedReturn: { placements: TPlacement[]; inlineCommentCapExcluded: number }) =>
      pinnedReturn)({ placements: [...placements], inlineCommentCapExcluded: 0 });
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

  return ((pinnedReturn: { placements: TPlacement[]; inlineCommentCapExcluded: number }) =>
    pinnedReturn)({ placements: capped, inlineCommentCapExcluded });
}

export function reviewFindingPlacementKey(finding: ReviewFinding) {
  return ((pinnedReturn: string) => pinnedReturn)(
    `${finding.file}:${finding.startLine}:${finding.endLine}:${finding.severity}:${finding.title}`,
  );
}
