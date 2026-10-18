import {
  REVIEW_SIZE_TIER_LARGE_MIN_CHANGES,
  REVIEW_SIZE_TIER_MEDIUM_MAX_FILES,
  REVIEW_SIZE_TIER_SMALL_MAX_FILES,
} from "../../settings/index.ts";

export type ReviewBudgetTier = "small" | "medium" | "large";

export type ReviewSizeBudgetInput = {
  readonly fileCount: number;
  readonly totalChanges: number;
  readonly truncated: boolean;
};

export type ReviewSizeBudget = {
  readonly tier: ReviewBudgetTier;
  readonly truncated: boolean;
  readonly fileCount: number;
  readonly totalChanges: number;
};

export function classifyReviewBudgetTier(input: ReviewSizeBudgetInput): ReviewBudgetTier {
  if (
    input.fileCount > REVIEW_SIZE_TIER_MEDIUM_MAX_FILES ||
    input.totalChanges >= REVIEW_SIZE_TIER_LARGE_MIN_CHANGES
  ) {
    return "large";
  }
  if (input.fileCount > REVIEW_SIZE_TIER_SMALL_MAX_FILES) {
    return "medium";
  }
  return "small";
}

export function buildReviewSizeBudget(input: ReviewSizeBudgetInput): ReviewSizeBudget {
  return {
    tier: classifyReviewBudgetTier(input),
    truncated: input.truncated,
    fileCount: input.fileCount,
    totalChanges: input.totalChanges,
  };
}
