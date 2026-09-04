import { describe, expect, it } from "vitest";
import { automatedReviewTestsSystemPrompt } from "../src/agent/prompts/reviewTestsPrompt.js";

describe("automatedReviewTestsSystemPrompt", () => {
  it("builds and includes the findings-report contract and P0–P3 mapping", () => {
    expect(automatedReviewTestsSystemPrompt.length).toBeGreaterThan(500);
    expect(automatedReviewTestsSystemPrompt).toContain("submit_findings_report");
    expect(automatedReviewTestsSystemPrompt).toContain("no_findings");
    expect(automatedReviewTestsSystemPrompt).toContain("**P0**");
    expect(automatedReviewTestsSystemPrompt).toContain("**P1**");
    expect(automatedReviewTestsSystemPrompt).toContain("**P2**");
    expect(automatedReviewTestsSystemPrompt).toContain("**P3**");
    expect(automatedReviewTestsSystemPrompt).toContain("Draft skeletons are required");
    expect(automatedReviewTestsSystemPrompt).toContain("the exact changed behaviour");
    expect(automatedReviewTestsSystemPrompt).toContain(
      "the plausible regression the test would catch",
    );
    expect(automatedReviewTestsSystemPrompt).not.toContain("securityConcerns");
  });

  it("keeps the read-only proposal posture", () => {
    expect(automatedReviewTestsSystemPrompt).toContain(
      "Never write or commit test files to the repository",
    );
    expect(automatedReviewTestsSystemPrompt).not.toContain(
      "you report problems, not prescriptions",
    );
  });
});
