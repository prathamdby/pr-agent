import { describe, expect, it } from "vitest";
import {
  buildReviewSizeBudget,
  classifyReviewBudgetTier,
} from "../src/review/reviewTrustedContext.js";

describe("classifyReviewBudgetTier", () => {
  it("classifies small PRs", () => {
    expect(
      classifyReviewBudgetTier({
        fileCount: 3,
        totalChanges: 40,
      }),
    ).toBe("small");
  });

  it("classifies large PRs by file count or total changes", () => {
    expect(
      classifyReviewBudgetTier({
        fileCount: 80,
        totalChanges: 100,
      }),
    ).toBe("large");
    expect(
      classifyReviewBudgetTier({
        fileCount: 5,
        totalChanges: 2500,
      }),
    ).toBe("large");
  });
});

describe("buildReviewSizeBudget", () => {
  it("notes truncation in trusted context block", () => {
    const budget = buildReviewSizeBudget({
      files: [],
      fileCount: 10,
      totalChanges: 100,
      truncated: true,
    });
    expect(budget.truncated).toBe(true);
  });
});
