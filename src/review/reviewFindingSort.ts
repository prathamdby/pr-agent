import { REVIEW_SEVERITY_RANK } from "../settings.js";
import type { ReviewFinding } from "./reviewSchema.js";

/** Canonical ordering: severity, file path, start line. */
export function compareReviewFindingsBySeverityFileLine(
  a: ReviewFinding,
  b: ReviewFinding,
): number {
  const bySeverity = REVIEW_SEVERITY_RANK[a.severity] - REVIEW_SEVERITY_RANK[b.severity];
  if (bySeverity !== 0) return bySeverity;
  const byFile = a.file.localeCompare(b.file);
  if (byFile !== 0) return byFile;
  return a.startLine - b.startLine;
}
