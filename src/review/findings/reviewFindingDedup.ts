import { normalizeFindingSubstance } from "./reviewFindingFingerprint.js";
import { compareReviewFindingsBySeverityFileLine } from "./reviewFindingSort.js";
import type { ReviewFinding } from "../reviewSchema.js";

type NormalizedFinding = {
  readonly finding: ReviewFinding;
  readonly title: string;
  readonly detail: string;
};

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
    const key = `${normalized.finding.file}\0${normalized.title}\0${normalized.detail}`;
    const bucket = buckets.get(key) ?? [];
    if (
      bucket.some(
        (existing) =>
          existing.finding.startLine <= normalized.finding.endLine &&
          normalized.finding.startLine <= existing.finding.endLine,
      )
    ) {
      continue;
    }
    bucket.push(normalized);
    buckets.set(key, bucket);
    kept.push(candidate);
  }

  return kept;
}
