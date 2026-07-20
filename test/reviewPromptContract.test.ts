import { describe, expect, it } from "vitest";
import { automatedQualitySystemPrompt } from "../src/agent/prompts/qualityPrompt.js";
import { automatedReviewTestsSystemPrompt } from "../src/agent/prompts/reviewTestsPrompt.js";
import { automatedSecuritySystemPrompt } from "../src/agent/prompts/securityPrompt.js";
import {
  structuredDeliveryHeader,
  VALIDATION_REPAIR_REMINDER,
  VALIDATION_REPAIR_ROUND0_SUFFIX,
  securityTripwiresGuidance,
  proseContractGuidance,
  agentInstructionFilesGuidance,
} from "../src/review/prompts/reviewPromptBlocks.js";
import { buildAutomatedSystemPrompt } from "../src/review/prompts/reviewSystemPrompt.js";

const LENS_PROMPTS = [
  ["general", buildAutomatedSystemPrompt()],
  ["security", automatedSecuritySystemPrompt],
  ["quality", automatedQualitySystemPrompt],
  ["tests", automatedReviewTestsSystemPrompt],
] as const;

describe("review prompt shared contract blocks", () => {
  it("reuses the shared structured delivery header in every lens", () => {
    for (const [name, prompt] of LENS_PROMPTS) {
      expect(prompt, `${name} should include shared delivery header`).toContain(
        structuredDeliveryHeader,
      );
    }
  });

  it("keeps single-pass submitReview obligations in every lens", () => {
    for (const [name, prompt] of LENS_PROMPTS) {
      expect(prompt, `${name} should require one submitReview call`).toContain(
        "submitReview exactly once",
      );
    }
  });
});

describe("review lens-specific obligations", () => {
  it("keeps general correctness reporting gate", () => {
    expect(buildAutomatedSystemPrompt()).toContain("you report problems, not prescriptions");
  });

  it("keeps security-only severity mapping", () => {
    expect(automatedSecuritySystemPrompt).toContain(
      "Do not report general correctness bugs, style issues, or non-security logic errors",
    );
    expect(automatedSecuritySystemPrompt).toContain("Security lens: set category to security");
  });

  it("keeps quality restructuring prescriptions", () => {
    expect(automatedQualitySystemPrompt).toContain("Prescriptions are required");
    expect(automatedQualitySystemPrompt).toContain("code-judo move");
  });

  it("keeps tests draft skeleton guidance", () => {
    expect(automatedReviewTestsSystemPrompt).toContain("Draft skeletons are required");
    expect(automatedReviewTestsSystemPrompt).toContain("draft test skeleton");
  });

  it("includes security tripwires and prose contracts only in the general lens", () => {
    const [general] = LENS_PROMPTS;
    expect(general[1]).toContain(securityTripwiresGuidance);
    expect(general[1]).toContain(proseContractGuidance);

    for (const [name, prompt] of LENS_PROMPTS.slice(1)) {
      expect(
        prompt,
        `${name} lens must not carry the general-lens security tripwires block`,
      ).not.toContain(securityTripwiresGuidance);
      expect(
        prompt,
        `${name} lens must not carry the general-lens prose contracts block`,
      ).not.toContain(proseContractGuidance);
    }
  });

  it("includes agent instruction files guidance in every review lens", () => {
    for (const [name, prompt] of LENS_PROMPTS) {
      expect(prompt, `${name} should include agent instruction files guidance`).toContain(
        agentInstructionFilesGuidance,
      );
    }
  });
});

describe("validation repair prompt suffixes", () => {
  it("keeps round-0 repair wording distinct from later reminders", () => {
    expect(VALIDATION_REPAIR_ROUND0_SUFFIX).toContain("complete ReviewPayload");
    expect(VALIDATION_REPAIR_REMINDER).toContain("tool schema");
    expect(VALIDATION_REPAIR_REMINDER).not.toContain("Minimal valid example");
  });
});
