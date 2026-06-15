import { describe, expect, it } from "vitest";
import { automatedReviewTestsSystemPrompt } from "../src/agent/prompts/reviewTestsPrompt.js";

describe("automatedReviewTestsSystemPrompt", () => {
  it("builds and includes submitReview contract and P0–P3 mapping", () => {
    expect(automatedReviewTestsSystemPrompt.length).toBeGreaterThan(500);
    expect(automatedReviewTestsSystemPrompt).toContain("submitReview exactly once");
    expect(automatedReviewTestsSystemPrompt).toContain("**P0**");
    expect(automatedReviewTestsSystemPrompt).toContain("**P1**");
    expect(automatedReviewTestsSystemPrompt).toContain("**P2**");
    expect(automatedReviewTestsSystemPrompt).toContain("**P3**");
    expect(automatedReviewTestsSystemPrompt).toContain("Draft skeletons are required");
    expect(automatedReviewTestsSystemPrompt).toContain("securityConcerns: null");
  });

  it("keeps the read-only proposal posture", () => {
    expect(automatedReviewTestsSystemPrompt).toContain(
      "never write or commit test files to the repository",
    );
    expect(automatedReviewTestsSystemPrompt).not.toContain(
      "you report problems, not prescriptions",
    );
  });
});
