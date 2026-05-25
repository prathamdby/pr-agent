import type { ReviewFinding } from "./reviewSchema.js";
import { selectInlineFindings } from "./reviewSchema.js";
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
  readonly inlineCapEligible: boolean;
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
  maxInlineFindings: number,
  diffIndex: CachedPrDiffIndex | undefined,
): InlinePlacement[] {
  const inlineCandidates = selectInlineFindings(findings, maxInlineFindings);
  const inlineCapIndices = new Set<number>();
  for (const candidate of inlineCandidates) {
    const index = findings.indexOf(candidate);
    if (index >= 0) inlineCapIndices.add(index);
  }

  return findings.map((finding, index) => {
    if (!inlineCapIndices.has(index)) {
      return { finding, inlineLine: null, inlinePosted: false, inlineCapEligible: false };
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
      inlineCapEligible: true,
    };
  });
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
