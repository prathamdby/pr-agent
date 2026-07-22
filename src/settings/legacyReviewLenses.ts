export const LEGACY_REVIEW_LENSES = ["review-security", "review-quality", "review-tests"] as const;

export const LEGACY_REVIEW_SUMMARY_SENTINELS = [
  "## PR Agent Security Review",
  "## PR Agent Quality Review",
  "## PR Agent Tests Review",
] as const;

export const LEGACY_REVIEW_POINTER_BODIES = [
  "See the security review summary in the PR conversation.",
  "See the code-quality review summary in the PR conversation.",
  "See the proposed test cases summary in the PR conversation.",
] as const;

export type LegacyReviewLens = (typeof LEGACY_REVIEW_LENSES)[number];
export type AnyReviewLens = "review" | LegacyReviewLens;

export function isAnyReviewLens(value: string): value is AnyReviewLens {
  switch (value) {
    case "review":
    case "review-security":
    case "review-quality":
    case "review-tests":
      return true;
    default:
      return false;
  }
}

export function normalizeReviewLens(_lens: AnyReviewLens): "review" {
  return "review";
}
