import { REVIEW_RISK_PATH_PATTERNS } from "../settings.js";
import type { ReviewPreflightMetadata } from "./reviewPreflightFiles.js";
import {
  fetchPriorInlineReviewFeedback,
  formatPriorInlineFeedbackBlock,
} from "./reviewPriorFeedback.js";
import type { ReviewMode } from "./reviewSchema.js";
import {
  REVIEW_SIZE_TIER_LARGE_MIN_CHANGES,
  REVIEW_SIZE_TIER_MEDIUM_MAX_FILES,
  REVIEW_SIZE_TIER_SMALL_MAX_FILES,
} from "../settings.js";

type ReviewPathRiskCategory = keyof typeof REVIEW_RISK_PATH_PATTERNS;

type ReviewPathProfile = {
  readonly changedFiles: readonly string[];
  readonly riskCategories: readonly ReviewPathRiskCategory[];
};

type ReviewBudgetTier = "small" | "medium" | "large";

type ReviewSizeBudget = {
  readonly tier: ReviewBudgetTier;
  readonly truncated: boolean;
  readonly fileCount: number;
  readonly totalChanges: number;
};

function matchesCategory(filename: string, category: ReviewPathRiskCategory): boolean {
  return REVIEW_RISK_PATH_PATTERNS[category].some((pattern) => pattern.test(filename));
}

function buildReviewPathProfile(changedFiles: readonly string[]): ReviewPathProfile {
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

function formatReviewPathProfileBlock(profile: ReviewPathProfile): string {
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

function classifyReviewBudgetTier(input: {
  readonly fileCount: number;
  readonly totalChanges: number;
}): ReviewBudgetTier {
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

function buildReviewSizeBudget(metadata: ReviewPreflightMetadata): ReviewSizeBudget {
  return {
    tier: classifyReviewBudgetTier(metadata),
    truncated: metadata.truncated,
    fileCount: metadata.fileCount,
    totalChanges: metadata.totalChanges,
  };
}

function formatReviewSizeBudgetBlock(budget: ReviewSizeBudget): string {
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

function buildTrustedReviewContextBlock(
  metadata: ReviewPreflightMetadata,
  extras?: { priorInlineFeedback?: string; repoPolicyBlock?: string },
): string {
  const filenames = metadata.files.map((file) => file.filename);
  const pathProfile = buildReviewPathProfile(filenames);
  const sizeBudget = buildReviewSizeBudget(metadata);

  const blocks = [
    formatReviewPathProfileBlock(pathProfile),
    "",
    formatReviewSizeBudgetBlock(sizeBudget),
  ];
  if (extras?.priorInlineFeedback) {
    blocks.push("", extras.priorInlineFeedback);
  }
  if (extras?.repoPolicyBlock) {
    blocks.push("", extras.repoPolicyBlock);
  }
  return blocks.join("\n");
}

export async function fetchPriorInlineFeedbackBlockForReview(params: {
  token: string;
  owner: string;
  repo: string;
  prNumber: number;
  reviewLens: ReviewMode;
  botUserId: number;
  onPriorFeedbackError?: (error: unknown) => void;
}): Promise<string | undefined> {
  try {
    const threads = await fetchPriorInlineReviewFeedback(
      params.token,
      params.owner,
      params.repo,
      params.prNumber,
      params.reviewLens,
      params.botUserId,
    );
    return formatPriorInlineFeedbackBlock(threads) || undefined;
  } catch (error) {
    params.onPriorFeedbackError?.(error);
    return undefined;
  }
}

export function buildTrustedReviewContext(params: {
  preflight: ReviewPreflightMetadata;
  priorInlineFeedback?: string;
  repoPolicyBlock?: string;
}): string {
  return buildTrustedReviewContextBlock(params.preflight, {
    priorInlineFeedback: params.priorInlineFeedback,
    repoPolicyBlock: params.repoPolicyBlock,
  });
}

export {
  buildReviewPathProfile,
  formatReviewPathProfileBlock,
  classifyReviewBudgetTier,
  buildReviewSizeBudget,
};
