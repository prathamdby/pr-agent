import { REVIEW_SEVERITY_RANK } from "../settings/index.js";
import type { ReviewFinding } from "./reviewSchema.js";

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

function compareFindings(a: ReviewFinding, b: ReviewFinding): number {
  const bySeverity = REVIEW_SEVERITY_RANK[a.severity] - REVIEW_SEVERITY_RANK[b.severity];
  if (bySeverity !== 0) return bySeverity;
  const byFile = a.file.localeCompare(b.file);
  if (byFile !== 0) return byFile;
  return a.startLine - b.startLine;
}

/** Drop duplicates when same file and overlapping line range; keep first by severity order. */
export function dedupeReviewFindings(findings: readonly ReviewFinding[]): ReviewFinding[] {
  const sorted = [...findings].toSorted(compareFindings);
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
