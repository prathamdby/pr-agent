import type { ReviewFinding } from "./reviewSchema.js";
import { selectInlineFindings } from "./reviewSchema.js";
import {
  createCachedPrDiffIndex,
  ingestListPullRequestFilesResult,
  resolveInlineAnchorLine,
  type CachedPrDiffIndex,
} from "./reviewDiffIndex.js";

export type InlinePlacement = {
  readonly finding: ReviewFinding;
  readonly inlineLine: number | null;
  readonly inlinePosted: boolean;
  readonly inlineCapEligible: boolean;
};

export { createCachedPrDiffIndex, ingestListPullRequestFilesResult, type CachedPrDiffIndex };

export function planInlinePlacements(
  findings: ReviewFinding[],
  maxInlineFindings: number,
  diffIndex: CachedPrDiffIndex | undefined,
): InlinePlacement[] {
  const inlineCandidates = selectInlineFindings(findings, maxInlineFindings);
  const inlineCapSet = new Set(inlineCandidates.map(findingKey));

  return findings.map((finding) => {
    if (!inlineCapSet.has(findingKey(finding))) {
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

function findingKey(finding: ReviewFinding): string {
  return `${finding.severity}|${finding.file}|${finding.startLine}|${finding.endLine}|${finding.title}`;
}

export function isLineResolutionPublishError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /line could not be resolved/i.test(message) ||
    /pull request review thread line.*invalid/i.test(message) ||
    /must be part of the diff/i.test(message)
  );
}
