import { compareReviewFindingsBySeverityFileLine } from "./reviewFindingSort.js";
import type { ReviewFinding } from "./reviewSchema.js";

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

/** Drop duplicates when same file and overlapping line range; keep first by severity order. */
export function dedupeReviewFindings(findings: readonly ReviewFinding[]): ReviewFinding[] {
  const sorted = [...findings].toSorted(compareReviewFindingsBySeverityFileLine);
  const kept: ReviewFinding[] = [];

  for (const candidate of sorted) {
    const duplicate = kept.some(
      (existing) =>
        existing.file === candidate.file &&
        rangesOverlap(
          existing.startLine,
          existing.endLine,
          candidate.startLine,
          candidate.endLine,
        ),
    );
    if (!duplicate) kept.push(candidate);
  }

  return kept;
}
