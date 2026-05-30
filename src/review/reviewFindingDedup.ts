import { normalizeFindingSubstance } from "./reviewFindingFingerprint.js";
import { compareReviewFindingsBySeverityFileLine } from "./reviewFindingSort.js";
import type { ReviewFinding } from "./reviewSchema.js";

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

function isDuplicateFinding(existing: ReviewFinding, candidate: ReviewFinding): boolean {
  if (existing.file !== candidate.file) return false;
  if (
    !rangesOverlap(existing.startLine, existing.endLine, candidate.startLine, candidate.endLine)
  ) {
    return false;
  }
  return (
    normalizeFindingSubstance(existing.title) === normalizeFindingSubstance(candidate.title) &&
    normalizeFindingSubstance(existing.detail) === normalizeFindingSubstance(candidate.detail)
  );
}

/** Drop duplicates when same file, overlapping lines, and matching title/detail; keep higher severity. */
export function dedupeReviewFindings(findings: readonly ReviewFinding[]): ReviewFinding[] {
  const sorted = [...findings].toSorted(compareReviewFindingsBySeverityFileLine);
  const kept: ReviewFinding[] = [];

  for (const candidate of sorted) {
    if (!kept.some((existing) => isDuplicateFinding(existing, candidate))) {
      kept.push(candidate);
    }
  }

  return kept;
}
