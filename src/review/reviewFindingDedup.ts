import { normalizeFindingSubstance } from "./reviewFindingFingerprint.js";
import { compareReviewFindingsBySeverityFileLine } from "./reviewFindingSort.js";
import type { ReviewFinding } from "./reviewSchema.js";

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

type NormalizedFinding = {
  readonly finding: ReviewFinding;
  readonly title: string;
  readonly detail: string;
};

function dedupeKey(finding: NormalizedFinding): string {
  return `${finding.finding.file}\0${finding.title}\0${finding.detail}`;
}

function isDuplicateFinding(existing: NormalizedFinding, candidate: NormalizedFinding): boolean {
  if (
    !rangesOverlap(
      existing.finding.startLine,
      existing.finding.endLine,
      candidate.finding.startLine,
      candidate.finding.endLine,
    )
  ) {
    return false;
  }
  return true;
}

/** Drop duplicates when same file, overlapping lines, and matching title/detail; keep higher severity. */
export function dedupeReviewFindings(findings: readonly ReviewFinding[]): ReviewFinding[] {
  const sorted = [...findings].toSorted(compareReviewFindingsBySeverityFileLine);
  const kept: ReviewFinding[] = [];
  const buckets = new Map<string, NormalizedFinding[]>();

  for (const candidate of sorted) {
    const normalized = {
      finding: candidate,
      title: normalizeFindingSubstance(candidate.title),
      detail: normalizeFindingSubstance(candidate.detail),
    };
    const key = dedupeKey(normalized);
    const bucket = buckets.get(key) ?? [];
    if (bucket.some((existing) => isDuplicateFinding(existing, normalized))) continue;
    bucket.push(normalized);
    buckets.set(key, bucket);
    kept.push(candidate);
  }

  return kept;
}
