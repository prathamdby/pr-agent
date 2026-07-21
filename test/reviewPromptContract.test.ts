import { describe, expect, it } from "vitest";
import {
  structuredDeliveryHeader,
  VALIDATION_REPAIR_REMINDER,
  VALIDATION_REPAIR_ROUND0_SUFFIX,
  securityTripwiresGuidance,
  proseContractGuidance,
  agentInstructionFilesGuidance,
} from "../src/review/prompts/reviewPromptBlocks.js";
import { buildAutomatedSystemPrompt } from "../src/review/prompts/reviewSystemPrompt.js";

const REVIEW_PROMPT = buildAutomatedSystemPrompt();

describe("review prompt shared contract blocks", () => {
  it("reuses the shared structured delivery header", () => {
    expect(REVIEW_PROMPT, "review should include shared delivery header").toContain(
      structuredDeliveryHeader,
    );
  });

  it("keeps the single-pass submitReview obligation", () => {
    expect(REVIEW_PROMPT, "review should require one submitReview call").toContain(
      "submitReview exactly once",
    );
  });
});

describe("review prompt obligations", () => {
  it("keeps general correctness reporting gate", () => {
    expect(buildAutomatedSystemPrompt()).toContain("you report problems, not prescriptions");
  });

  it("includes security tripwires and prose contracts", () => {
    const prompt = buildAutomatedSystemPrompt();
    expect(prompt).toContain(securityTripwiresGuidance);
    expect(prompt).toContain(proseContractGuidance);
  });

  it("includes agent instruction files guidance", () => {
    expect(REVIEW_PROMPT, "review should include agent instruction files guidance").toContain(
      agentInstructionFilesGuidance,
    );
  });
});

describe("validation repair prompt suffixes", () => {
  it("keeps round-0 repair wording distinct from later reminders", () => {
    expect(VALIDATION_REPAIR_ROUND0_SUFFIX).toContain("complete ReviewPayload");
    expect(VALIDATION_REPAIR_REMINDER).toContain("tool schema");
    expect(VALIDATION_REPAIR_REMINDER).not.toContain("Minimal valid example");
  });
});
