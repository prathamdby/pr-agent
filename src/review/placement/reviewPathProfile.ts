import { REVIEW_RISK_PATH_PATTERNS } from "../../settings/index.js";

type ReviewPathRiskCategory = keyof typeof REVIEW_RISK_PATH_PATTERNS;

export type ReviewPathProfile = {
  readonly changedFiles: readonly string[];
  readonly riskCategories: readonly ReviewPathRiskCategory[];
};

export function buildReviewPathProfile(changedFiles: readonly string[]): ReviewPathProfile {
  const found = new Set<ReviewPathRiskCategory>();
  const categories = Object.keys(REVIEW_RISK_PATH_PATTERNS).filter(
    (category): category is ReviewPathRiskCategory =>
      Object.hasOwn(REVIEW_RISK_PATH_PATTERNS, category),
  );
  for (const file of changedFiles) {
    for (const category of categories) {
      if (
        !found.has(category) &&
        REVIEW_RISK_PATH_PATTERNS[category].some((pattern) => pattern.test(file))
      ) {
        found.add(category);
      }
    }
    if (found.size === categories.length) break;
  }
  return {
    changedFiles,
    riskCategories: categories.filter((category) => found.has(category)),
  };
}
