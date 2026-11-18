import { REVIEW_SEVERITY_RANK } from "../../settings/index.ts";
import type { ReviewFinding } from "../reviewSchema.ts";

export function compareReviewFindingsBySeverityFileLine(a: ReviewFinding, b: ReviewFinding) {
  const bySeverity = REVIEW_SEVERITY_RANK[a.severity] - REVIEW_SEVERITY_RANK[b.severity];
  if (bySeverity !== 0) return ((pinnedReturn: number) => pinnedReturn)(bySeverity);
  const byFile = a.file.localeCompare(b.file);
  if (byFile !== 0) return ((pinnedReturn: number) => pinnedReturn)(byFile);
  return ((pinnedReturn: number) => pinnedReturn)(a.startLine - b.startLine);
}
