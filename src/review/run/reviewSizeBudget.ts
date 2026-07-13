import {
  REVIEW_CORE_REVIEWER_IDS,
  REVIEW_SIZE_TIER_LARGE_MIN_CHANGES,
  REVIEW_SIZE_TIER_MEDIUM_MAX_FILES,
  REVIEW_SIZE_TIER_SMALL_MAX_CHANGES,
  REVIEW_SIZE_TIER_SMALL_MAX_FILES,
} from "../../settings/index.js";
import { REVIEWER_IDS, type ReviewerId } from "../prompts/reviewerPrompt.js";

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
  readonly selectedReviewerIds: readonly ReviewerId[];
  readonly omittedReviewerIds: readonly ReviewerId[];
};

const CORE_REVIEWER_ID_SET = new Set<string>(REVIEW_CORE_REVIEWER_IDS);

export function classifyReviewBudgetTier(input: ReviewSizeBudgetInput): ReviewBudgetTier {
  // Truncated listings understate size; never treat them as small full-roster reviews.
  if (input.truncated) {
    if (
      input.fileCount > REVIEW_SIZE_TIER_MEDIUM_MAX_FILES ||
      input.totalChanges >= REVIEW_SIZE_TIER_LARGE_MIN_CHANGES
    ) {
      return "large";
    }
    return "medium";
  }
  if (
    input.fileCount > REVIEW_SIZE_TIER_MEDIUM_MAX_FILES ||
    input.totalChanges >= REVIEW_SIZE_TIER_LARGE_MIN_CHANGES
  ) {
    return "large";
  }
  if (
    input.fileCount > REVIEW_SIZE_TIER_SMALL_MAX_FILES ||
    input.totalChanges > REVIEW_SIZE_TIER_SMALL_MAX_CHANGES
  ) {
    return "medium";
  }
  return "small";
}

/** Select Reviewer agents for this Review budget tier (ADR 0023). */
export function selectReviewerRoster(tier: ReviewBudgetTier): readonly ReviewerId[] {
  if (tier === "small") return REVIEWER_IDS;
  const selected = REVIEWER_IDS.filter((id) => CORE_REVIEWER_ID_SET.has(id));
  // Required coverage must always be present in the selected roster.
  if (!selected.includes("correctness") || !selected.includes("security")) {
    throw new Error("Core Reviewer roster must include correctness and security");
  }
  return selected;
}

export function buildReviewSizeBudget(input: ReviewSizeBudgetInput): ReviewSizeBudget {
  const tier = classifyReviewBudgetTier(input);
  const selectedReviewerIds = selectReviewerRoster(tier);
  const selected = new Set<string>(selectedReviewerIds);
  return {
    tier,
    truncated: input.truncated,
    fileCount: input.fileCount,
    totalChanges: input.totalChanges,
    selectedReviewerIds,
    omittedReviewerIds: REVIEWER_IDS.filter((id) => !selected.has(id)),
  };
}

export function formatReviewSizeBudgetBlock(budget: ReviewSizeBudget): string {
  const lines = [
    "Trusted context (review budget tier):",
    `- Tier: ${budget.tier}`,
    `- Changed files: ${budget.fileCount}`,
    `- Total line changes (additions + deletions): ${budget.totalChanges}`,
    `- Selected Reviewer agents: ${budget.selectedReviewerIds.join(", ")}`,
  ];
  if (budget.omittedReviewerIds.length > 0) {
    lines.push(`- Omitted by policy (not a failure): ${budget.omittedReviewerIds.join(", ")}`);
  }
  if (budget.truncated) {
    lines.push("- Change set truncated: treat coverage as partial and note limits in prCharacter.");
  }
  if (budget.tier === "large") {
    lines.push(
      "- Large PR: prioritize investigation order (auth, migrations, security first), but report every evidenced P0–P2 found across the full diff.",
    );
  }
  if (budget.tier !== "small") {
    lines.push(
      "- Core roster: absorb omitted-angle risks into your assigned angle when they are evidenced; do not invent findings for angles outside your remit.",
    );
  }
  return lines.join("\n");
}
