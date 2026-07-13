import { describe, expect, it } from "vitest";
import { REVIEW_CORE_REVIEWER_IDS } from "../src/settings/index.js";
import {
  buildReviewSizeBudget,
  classifyReviewBudgetTier,
  formatReviewSizeBudgetBlock,
  selectReviewerRoster,
} from "../src/review/run/reviewSizeBudget.js";
import { REVIEWER_IDS } from "../src/review/prompts/reviewerPrompt.js";

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

  it("classifies medium by file count or change volume", () => {
    expect(
      classifyReviewBudgetTier({
        fileCount: 15,
        totalChanges: 100,
        truncated: false,
      }),
    ).toBe("medium");
    expect(
      classifyReviewBudgetTier({
        fileCount: 3,
        totalChanges: 600,
        truncated: false,
      }),
    ).toBe("medium");
  });

  it("classifies large PRs by file count or total changes", () => {
    expect(
      classifyReviewBudgetTier({
        fileCount: 80,
        totalChanges: 100,
        truncated: false,
      }),
    ).toBe("large");
    expect(
      classifyReviewBudgetTier({
        fileCount: 5,
        totalChanges: 2500,
        truncated: false,
      }),
    ).toBe("large");
  });
});

describe("selectReviewerRoster", () => {
  it("selects the full roster for small tiers", () => {
    expect(selectReviewerRoster("small")).toEqual(REVIEWER_IDS);
  });

  it("selects the core roster for medium and large tiers", () => {
    expect(selectReviewerRoster("medium")).toEqual([...REVIEW_CORE_REVIEWER_IDS]);
    expect(selectReviewerRoster("large")).toEqual([...REVIEW_CORE_REVIEWER_IDS]);
  });
});

describe("buildReviewSizeBudget", () => {
  it("notes truncation and selected roster in trusted context block", () => {
    const budget = buildReviewSizeBudget({
      fileCount: 10,
      totalChanges: 100,
      truncated: true,
    });
    expect(budget.truncated).toBe(true);
    expect(budget.selectedReviewerIds).toEqual(REVIEWER_IDS);
    expect(budget.omittedReviewerIds).toEqual([]);
    const block = formatReviewSizeBudgetBlock(budget);
    expect(block).toContain("Change set truncated");
    expect(block).toContain("Selected Reviewer agents:");
  });

  it("lists omitted reviewers for large tiers without calling them failures", () => {
    const budget = buildReviewSizeBudget({
      fileCount: 80,
      totalChanges: 100,
      truncated: false,
    });
    expect(budget.tier).toBe("large");
    expect(budget.selectedReviewerIds).toEqual([...REVIEW_CORE_REVIEWER_IDS]);
    expect(budget.omittedReviewerIds).toContain("adversarial");
    const block = formatReviewSizeBudgetBlock(budget);
    expect(block).toContain("Omitted by policy (not a failure)");
    expect(block).not.toContain("Unavailable reviewers");
  });
});
