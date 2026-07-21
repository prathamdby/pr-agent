export const LEGACY_REVIEW_LENSES = ["review-security", "review-quality", "review-tests"] as const;

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
