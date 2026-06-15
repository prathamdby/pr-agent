import { describe, expect, it } from "vitest";
import { automatedQualitySystemPrompt } from "../src/agent/prompts/qualityPrompt.js";

describe("automatedQualitySystemPrompt", () => {
  it("builds and includes submitReview contract and P0–P3 mapping", () => {
    expect(automatedQualitySystemPrompt.length).toBeGreaterThan(500);
    expect(automatedQualitySystemPrompt).toContain("submitReview exactly once");
    expect(automatedQualitySystemPrompt).toContain("**P0**");
    expect(automatedQualitySystemPrompt).toContain("**P1**");
    expect(automatedQualitySystemPrompt).toContain("**P2**");
    expect(automatedQualitySystemPrompt).toContain("**P3**");
    expect(automatedQualitySystemPrompt).toContain("Prescriptions are required");
    expect(automatedQualitySystemPrompt).toContain("securityConcerns: null");
  });

  it("omits the general lens no-prescriptions gate", () => {
    expect(automatedQualitySystemPrompt).not.toContain("you report problems, not prescriptions");
  });
});
