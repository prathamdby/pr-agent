import { REVIEW_RISK_PATH_PATTERNS } from "../settings/index.js";

type ReviewPathRiskCategory = keyof typeof REVIEW_RISK_PATH_PATTERNS;

export type ReviewPathProfile = {
  readonly changedFiles: readonly string[];
  readonly riskCategories: readonly ReviewPathRiskCategory[];
};

function matchesCategory(filename: string, category: ReviewPathRiskCategory): boolean {
  return REVIEW_RISK_PATH_PATTERNS[category].some((pattern) => pattern.test(filename));
}

export function buildReviewPathProfile(changedFiles: readonly string[]): ReviewPathProfile {
  const found = new Set<ReviewPathRiskCategory>();
  const categories = Object.keys(REVIEW_RISK_PATH_PATTERNS) as ReviewPathRiskCategory[];
  for (const file of changedFiles) {
    for (const category of categories) {
      if (!found.has(category) && matchesCategory(file, category)) found.add(category);
    }
    if (found.size === categories.length) break;
  }
  return {
    changedFiles,
    riskCategories: categories.filter((category) => found.has(category)),
  };
}

export function formatReviewPathProfileBlock(profile: ReviewPathProfile): string {
  if (profile.riskCategories.length === 0) {
    return [
      "Trusted context (path profile):",
      `- Changed files: ${profile.changedFiles.length}`,
      "- No high-risk path categories detected in the file list.",
      "- Prioritize changed application code before docs and tests.",
    ].join("\n");
  }
  return [
    "Trusted context (path profile):",
    `- Changed files: ${profile.changedFiles.length}`,
    `- Risk categories present: ${profile.riskCategories.join(", ")}`,
    "- Investigate auth, migration, config, and security paths before lower-risk files.",
  ].join("\n");
}
