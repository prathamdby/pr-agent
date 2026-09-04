import { describe, expect, it } from "vitest";
import { automatedQualitySystemPrompt } from "../src/agent/prompts/qualityPrompt.js";

describe("automatedQualitySystemPrompt", () => {
  it("builds and includes the findings-report contract and P0–P3 mapping", () => {
    expect(automatedQualitySystemPrompt.length).toBeGreaterThan(500);
    expect(automatedQualitySystemPrompt).toContain("submit_findings_report");
    expect(automatedQualitySystemPrompt).toContain("no_findings");
    expect(automatedQualitySystemPrompt).toContain("**P0**");
    expect(automatedQualitySystemPrompt).toContain("**P1**");
    expect(automatedQualitySystemPrompt).toContain("**P2**");
    expect(automatedQualitySystemPrompt).toContain("**P3**");
    expect(automatedQualitySystemPrompt).toContain(
      "Prescriptions are required after a finding passes the present-harm gate",
    );
    expect(automatedQualitySystemPrompt).not.toContain("securityConcerns");
  });

  it("omits the correctness specialist no-prescriptions gate", () => {
    expect(automatedQualitySystemPrompt).not.toContain("you report problems, not prescriptions");
  });
});
