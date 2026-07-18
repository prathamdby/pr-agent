import { describe, expect, it } from "vitest";
import {
  REVIEW_SIZE_TIER_LARGE_MIN_CHANGES,
  REVIEW_SIZE_TIER_MEDIUM_MAX_FILES,
  REVIEW_SIZE_TIER_SMALL_MAX_FILES,
} from "../src/settings/reviewConstants.js";
import {
  buildReviewSizeBudget,
  classifyReviewBudgetTier,
  formatReviewSizeBudgetBlock,
} from "../src/review/run/reviewSizeBudget.js";

describe("classifyReviewBudgetTier", () => {
  it("classifies small PRs", () => {
    expect(
      classifyReviewBudgetTier({
        fileCount: 3,
        totalChanges: 40,
        truncated: false,
      }),
    ).toBe("small");
  });

  it("classifies medium PRs by file count", () => {
    expect(
      classifyReviewBudgetTier({
        fileCount: REVIEW_SIZE_TIER_SMALL_MAX_FILES + 1,
        totalChanges: 100,
        truncated: false,
      }),
    ).toBe("medium");
    expect(
      classifyReviewBudgetTier({
        fileCount: REVIEW_SIZE_TIER_MEDIUM_MAX_FILES,
        totalChanges: 100,
        truncated: false,
      }),
    ).toBe("medium");
  });

  it("classifies large PRs by file count or total changes", () => {
    expect(
      classifyReviewBudgetTier({
        fileCount: REVIEW_SIZE_TIER_MEDIUM_MAX_FILES + 1,
        totalChanges: 100,
        truncated: false,
      }),
    ).toBe("large");
    expect(
      classifyReviewBudgetTier({
        fileCount: 5,
        totalChanges: REVIEW_SIZE_TIER_LARGE_MIN_CHANGES,
        truncated: false,
      }),
    ).toBe("large");
  });
});

describe("buildReviewSizeBudget", () => {
  it("notes truncation in trusted context block", () => {
    const budget = buildReviewSizeBudget({
      fileCount: 10,
      totalChanges: 100,
      truncated: true,
    });
    expect(budget.truncated).toBe(true);
  });
});

describe("formatReviewSizeBudgetBlock", () => {
  it("includes tier and change counts", () => {
    const block = formatReviewSizeBudgetBlock({
      tier: "medium",
      truncated: false,
      fileCount: 25,
      totalChanges: 100,
    });
    expect(block).toContain("Trusted context (review budget tier):");
    expect(block).toContain("- Tier: medium");
    expect(block).toContain("- Changed files: 25");
    expect(block).toContain("- Total line changes (additions + deletions): 100");
    expect(block).not.toContain("Change set truncated");
    expect(block).not.toContain("Large PR:");
  });

  it("notes truncation and large-PR guidance when applicable", () => {
    const block = formatReviewSizeBudgetBlock({
      tier: "large",
      truncated: true,
      fileCount: 80,
      totalChanges: 2500,
    });
    expect(block).toContain("- Tier: large");
    expect(block).toContain(
      "- Change set truncated: treat coverage as partial and note limits in prCharacter.",
    );
    expect(block).toContain("- Large PR:");
  });
});
