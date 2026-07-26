import {
  REVIEW_SIZE_TIER_LARGE_MIN_CHANGES,
  REVIEW_SIZE_TIER_MEDIUM_MAX_FILES,
  REVIEW_SIZE_TIER_SMALL_MAX_FILES,
} from "../../settings/index.js";
import type { CheckoutCoverage } from "../../prWorkspace/localPrWorkspace.js";

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

export function formatReviewSizeBudgetBlock(budget: ReviewSizeBudget): string {
  const lines = [
    "Trusted context (review budget tier):",
    `- Tier: ${budget.tier}`,
    `- Changed files: ${budget.fileCount}`,
    `- Total line changes (additions + deletions): ${budget.totalChanges}`,
  ];
  if (budget.truncated) {
    lines.push("- Change set truncated: treat coverage as partial and note limits in prCharacter.");
  }
  if (budget.tier === "large") {
    lines.push(
      "- Large PR: prioritize investigation order (auth, migrations, security first), but report every evidenced P0–P2 found across the full diff.",
    );
  }
  return lines.join("\n");
}

export function formatCheckoutCoverageBlock(coverage: CheckoutCoverage): string {
  const modeLabel =
    coverage.mode === "sparse"
      ? `sparse (${coverage.pathsInCheckout} paths on disk)`
      : `full (${coverage.pathsInCheckout} paths on disk)`;
  const lines = [
    "Checkout coverage:",
    `- Mode: ${modeLabel}`,
    "- Search and reads only see these paths.",
    `- Changed files in PR: ${coverage.changedFileCount}`,
    `- Change set truncated: ${coverage.changeSetTruncated ? "yes" : "no"}`,
  ];
  if (coverage.mode === "sparse") {
    lines.push("- Sparse checkout: only changed paths are on disk, not the full repo.");
  }
  if (coverage.searchTruncated) {
    lines.push("- Last search truncated: yes");
  }
  if (coverage.warning) {
    lines.push(`- Warning: ${coverage.warning}`);
  }
  return lines.join("\n");
}
