import { describe, expect, it } from "vitest";
import { automatedQualitySystemPrompt } from "../src/agent/prompts/qualityPrompt.js";
import { automatedReviewTestsSystemPrompt } from "../src/agent/prompts/reviewTestsPrompt.js";
import { automatedSecuritySystemPrompt } from "../src/agent/prompts/securityPrompt.js";
import {
  VALIDATION_REPAIR_REMINDER,
  VALIDATION_REPAIR_ROUND0_SUFFIX,
  securityTripwiresGuidance,
  proseContractGuidance,
  agentInstructionFilesGuidance,
  pathAndSizeGuidance,
  specialistFindingsReportContract,
  reviewPayloadPerFindingContracts,
  repoPolicyGuidance,
} from "../src/review/prompts/reviewPromptBlocks.js";
import { buildAutomatedSystemPrompt } from "../src/review/prompts/reviewSystemPrompt.js";
import { context7OutboundDataGuidance } from "../src/agent/prompts/toolingDiscipline.js";

const SPECIALIST_PROMPTS = [
  ["correctness", buildAutomatedSystemPrompt()],
  ["security", automatedSecuritySystemPrompt],
  ["quality", automatedQualitySystemPrompt],
  ["tests", automatedReviewTestsSystemPrompt],
] as const;

describe("review prompt shared contract blocks", () => {
  it("reuses the shared findings-report contract in every specialist", () => {
    for (const [name, prompt] of SPECIALIST_PROMPTS) {
      expect(prompt, `${name} should include the findings-report contract`).toContain(
        specialistFindingsReportContract,
      );
    }
  });

  it("requires one specialist report in every review", () => {
    for (const [name, prompt] of SPECIALIST_PROMPTS) {
      expect(prompt, `${name} should require one findings report`).toContain(
        "submit_findings_report` exactly once",
      );
    }
  });
  it("steers findings toward changed-path anchors for coverage gaps", () => {
    expect(pathAndSizeGuidance).toContain("changed files");
    expect(pathAndSizeGuidance).toContain("coverage gaps");
    expect(specialistFindingsReportContract).toContain("commentable location on a changed path");
    expect(specialistFindingsReportContract).toContain("Coverage and missing-test findings");
  });
});

describe("specialist-specific obligations", () => {
  it("keeps general correctness reporting gate", () => {
    expect(buildAutomatedSystemPrompt()).toContain("you report problems, not prescriptions");
  });

  it("keeps security-only severity mapping", () => {
    expect(automatedSecuritySystemPrompt).toContain(
      "Do not report general correctness bugs, style issues, or non-security logic errors",
    );
    expect(automatedSecuritySystemPrompt).toContain(
      "Security specialist: set category to security",
    );
  });

  it("keeps quality restructuring prescriptions", () => {
    expect(automatedQualitySystemPrompt).toContain("Prescriptions are required");
    expect(automatedQualitySystemPrompt).toContain("code-judo move");
  });

  it("keeps tests draft skeleton guidance", () => {
    expect(automatedReviewTestsSystemPrompt).toContain(
      "Draft skeletons are required when this specialist reports findings",
    );
    expect(automatedReviewTestsSystemPrompt).toContain("draft test skeleton");
  });

  it("gates test suggestions on project testing posture", () => {
    expect(automatedReviewTestsSystemPrompt).toContain("## Testing posture (gate first)");
    expect(automatedReviewTestsSystemPrompt).toContain("**Incomplete evidence**");
    expect(automatedReviewTestsSystemPrompt).toContain(
      "Never choose **Brownfield, no tests** or **Greenfield, no tests** from that absence",
    );
    expect(automatedReviewTestsSystemPrompt).toContain("**Brownfield, no tests**");
    expect(automatedReviewTestsSystemPrompt).toContain("**Greenfield, no tests**");
    expect(automatedReviewTestsSystemPrompt).toContain(
      "only when checkout coverage is full (not sparse)",
    );
    expect(automatedReviewTestsSystemPrompt).toContain(
      "Do not recommend creating test files, scaffolding a suite, or adopting a framework",
    );
    expect(automatedReviewTestsSystemPrompt).toContain("Do not report missing-test findings");
    expect(automatedReviewTestsSystemPrompt).toContain(
      "Submit an empty report per the Findings report contract below",
    );
    expect(automatedReviewTestsSystemPrompt).not.toContain(
      'Call `submit_findings_report` with `status: "no_findings"` and `findings: []`',
    );
    expect(automatedReviewTestsSystemPrompt).toContain(
      "When unsure between brownfield and greenfield with no tests under full coverage, prefer brownfield",
    );
  });

  it("includes security tripwires and prose contracts only for correctness", () => {
    const [correctness] = SPECIALIST_PROMPTS;
    expect(correctness[1]).toContain(securityTripwiresGuidance);
    expect(correctness[1]).toContain(proseContractGuidance);

    for (const [name, prompt] of SPECIALIST_PROMPTS.slice(1)) {
      expect(
        prompt,
        `${name} must not carry the correctness security-tripwires block`,
      ).not.toContain(securityTripwiresGuidance);
      expect(prompt, `${name} must not carry the correctness prose-contracts block`).not.toContain(
        proseContractGuidance,
      );
    }
  });

  it("includes agent instruction files guidance in every specialist review", () => {
    for (const [name, prompt] of SPECIALIST_PROMPTS) {
      expect(prompt, `${name} should include agent instruction files guidance`).toContain(
        agentInstructionFilesGuidance,
      );
    }
  });

  it("includes the shared Context7 no-exfiltration guidance in every specialist review", () => {
    for (const [name, prompt] of SPECIALIST_PROMPTS) {
      expect(prompt, `${name} should include Context7 outbound guidance`).toContain(
        context7OutboundDataGuidance,
      );
    }
  });

  it("includes repo policy trust guidance in every specialist review", () => {
    for (const [name, prompt] of SPECIALIST_PROMPTS) {
      expect(prompt, `${name} should include repo policy trust guidance`).toContain(
        repoPolicyGuidance,
      );
    }
    expect(repoPolicyGuidance).toContain("Missing or malformed head/base repository identity");
    expect(repoPolicyGuidance).toContain("suppress, omit, or downgrade findings");
  });

  it("does not mention violatedRule in per-finding contracts or specialist prompts", () => {
    expect(reviewPayloadPerFindingContracts).not.toContain("violatedRule");
    for (const [name, prompt] of SPECIALIST_PROMPTS) {
      expect(prompt, `${name} must not mention violatedRule`).not.toContain("violatedRule");
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
