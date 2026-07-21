import { describe, expect, it } from "vitest";
import {
  securityTripwiresGuidance,
  proseContractGuidance,
  agentInstructionFilesGuidance,
  priorInlineFeedbackGuidance,
} from "../src/review/prompts/reviewPromptBlocks.js";
import { correctnessInvestigationBlocks } from "../src/review/prompts/reviewSystemPrompt.js";
import { specialistSystemPrompt } from "../src/review/orchestrator/prompts/specialistPersonas.js";
import { buildOrchestratorSystemPrompt } from "../src/review/orchestrator/prompts/orchestratorPrompts.js";

const CORRECTNESS_BLOCKS = correctnessInvestigationBlocks("submit_findings_report").join("\n");
const ORCHESTRATOR_PROMPT = buildOrchestratorSystemPrompt();

describe("orchestrator and specialist prompt contracts", () => {
  it("orchestrator owns publish tools, not submitReview", () => {
    expect(ORCHESTRATOR_PROMPT).toContain("publish_thread");
    expect(ORCHESTRATOR_PROMPT).toContain("publish_summary");
    expect(ORCHESTRATOR_PROMPT).toContain("submit_specialist_brief");
    expect(ORCHESTRATOR_PROMPT).not.toContain("submitReview");
  });

  it("correctness specialist uses submit_findings_report", () => {
    const prompt = specialistSystemPrompt("correctness");
    expect(prompt).toContain("submit_findings_report");
    expect(prompt).not.toContain("submitReview");
    expect(prompt).toContain("you report problems, not prescriptions");
  });
});

describe("review prompt obligations", () => {
  it("keeps general correctness reporting gate in investigation blocks", () => {
    expect(CORRECTNESS_BLOCKS).toContain("you report problems, not prescriptions");
  });

  it("includes security tripwires and prose contracts", () => {
    expect(CORRECTNESS_BLOCKS).toContain(securityTripwiresGuidance);
    expect(CORRECTNESS_BLOCKS).toContain(proseContractGuidance);
  });

  it("includes agent instruction files guidance", () => {
    expect(CORRECTNESS_BLOCKS).toContain(agentInstructionFilesGuidance);
  });

  it("scopes prior feedback to this review, not a removed lens", () => {
    expect(priorInlineFeedbackGuidance).toContain("this review");
    expect(priorInlineFeedbackGuidance).not.toContain("this lens");
  });
});
