import { describe, expect, it } from "vitest";
import { buildReviewSizeBudget, classifyReviewBudgetTier } from "../src/review/reviewSizeBudget.js";

describe("classifyReviewBudgetTier", () => {
  it("classifies small PRs", () => {
    expect(classifyReviewBudgetTier({ fileCount: 3, totalChanges: 40, truncated: false })).toBe(
      "small",
    );
  });

  it("classifies large PRs by file count or total changes", () => {
    expect(classifyReviewBudgetTier({ fileCount: 80, totalChanges: 100, truncated: false })).toBe(
      "large",
    );
    expect(classifyReviewBudgetTier({ fileCount: 5, totalChanges: 2500, truncated: false })).toBe(
      "large",
    );
  });
});

describe("buildReviewSizeBudget", () => {
  it("notes truncation in trusted context block", () => {
    const budget = buildReviewSizeBudget({ fileCount: 10, totalChanges: 100, truncated: true });
    expect(budget.truncated).toBe(true);
  });
});
