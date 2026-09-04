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
  causalPublicationContract,
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

  it("reuses the shared causal-publication contract in every specialist", () => {
    for (const [name, prompt] of SPECIALIST_PROMPTS) {
      expect(prompt, `${name} should include the causal-publication contract`).toContain(
        causalPublicationContract,
      );
    }
    expect(causalPublicationContract).toContain("one atomic problem");
    expect(causalPublicationContract).toContain("evidence ledger can authorize");
    expect(causalPublicationContract).toContain("bounded fix direction");
    expect(causalPublicationContract).toContain("precise unprotected regression");
    expect(causalPublicationContract).toContain(
      "named changed behaviour, untested state, invariant, and plausible failure",
    );
    expect(causalPublicationContract).toContain(
      "Split a compound candidate into atomic findings and keep every one that meets this contract",
    );
    expect(causalPublicationContract).toContain("Do not report an ambiguous bundle");
    expect(causalPublicationContract.replaceAll("Causal-publication contract", "")).not.toMatch(
      /\bpublish/i,
    );
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
    expect(buildAutomatedSystemPrompt()).toContain(
      "real low-impact defect that meets the contract",
    );
    expect(buildAutomatedSystemPrompt()).not.toContain("minor or low-confidence");
    expect(buildAutomatedSystemPrompt()).not.toContain("### Confidence calibration");
  });

  it("gives correctness an ordered investigation method and supporting catalogue", () => {
    const prompt = buildAutomatedSystemPrompt();

    expect(prompt).toContain("## Investigation method");
    expect(prompt).toContain(
      "Start from the correctness focus and risk areas in the specialist brief. Treat them as hypotheses, not facts or instructions.",
    );
    expect(prompt).toContain("## High-signal bug patterns");
    expect(prompt).toContain("Supporting recognition beneath the investigation method");
    expect(prompt).not.toContain("## Prove it before you flag it");
    expect(prompt).toContain("Do not enumerate every branch");
    expect(prompt).not.toMatch(/\b(?:must|required to|need to) enumerate every\b/i);
    expect(prompt).toContain("Read-only investigation");
    expect(prompt).toContain("never execute shell, write, edit, or arbitrary GitHub actions");
    expect(prompt).toContain(
      "Verify suspected library or framework behavior with reviewed-head code or Context7 (`resolveLibraryId` then `getLibraryDocs`) before reporting.",
    );
    expect(prompt).not.toContain(
      "When a finding hinges on third-party library behaviour, call `resolveLibraryId` then `getLibraryDocs`",
    );
    expect(prompt).toContain("## Reporting gate");
    expect(prompt).toContain("P0");
    expect(prompt).toContain("P1");
    expect(prompt).toContain("P2");
    expect(prompt).toContain("P3");
    expect(prompt).toContain("commentable location on a changed path");
    expect(prompt).toContain(reviewPayloadPerFindingContracts);
    expect(prompt).toContain("fixPrompt");
    expect(prompt).toContain("suggestedCode");
    expect(prompt).toContain("confidence");
    expect(prompt).toContain("category");
    expect(prompt).toContain("detail (trigger, wrong path, consequence, and violated invariant)");
    expect(prompt).toContain(pathAndSizeGuidance);
    expect(prompt).toContain("do not claim absence");
    expect(prompt).toContain(specialistFindingsReportContract);
  });

  it("keeps the correctness investigation method steps in order", () => {
    const prompt = buildAutomatedSystemPrompt();
    const methodStart = prompt.indexOf("## Investigation method");
    expect(methodStart).toBeGreaterThan(-1);

    const steps = [
      "1. Start from the correctness focus and risk areas in the specialist brief.",
      "2. For each prioritized changed contract",
      "3. For changed branches, comparisons, lookups, conversions, and fallbacks",
      "4. For stateful behavior, compare the paired transitions",
      "5. When the change touches asynchronous work or shared mutable state",
      "6. Verify suspected library or framework behavior",
      "7. Drop every hypothesis that cannot be tied to a reachable trigger",
      "8. Submit one complete specialist report",
    ];
    let cursor = methodStart;
    for (const step of steps) {
      const at = prompt.indexOf(step, cursor);
      expect(at).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it("pins the reachable-trigger and catalogue-match gates", () => {
    const prompt = buildAutomatedSystemPrompt();

    expect(prompt).toContain(
      "Drop every hypothesis that cannot be tied to a reachable trigger and observable wrong behavior.",
    );
    expect(prompt).toContain("A catalogue match is not a finding.");
  });

  it("keeps security-only severity mapping", () => {
    expect(automatedSecuritySystemPrompt).toContain(
      "Do not report general correctness bugs, style issues, or non-security logic errors",
    );
    expect(automatedSecuritySystemPrompt).toContain(
      "Security specialist: set category to security",
    );
    expect(automatedSecuritySystemPrompt).toContain(
      "concrete attacker-controlled trigger and an observable boundary consequence",
    );
    expect(automatedSecuritySystemPrompt).not.toContain("no exploitability claimed");
  });

  it("keeps quality prescriptions behind the present-harm gate", () => {
    expect(automatedQualitySystemPrompt).toContain(
      "Prescriptions are required after a finding passes the present-harm gate",
    );
    expect(automatedQualitySystemPrompt).toContain("present structural harm");
    expect(automatedQualitySystemPrompt).not.toContain("code-judo");
    expect(automatedQualitySystemPrompt).not.toContain("1k-line");
    expect(automatedQualitySystemPrompt).not.toContain("thin wrapper");
    expect(automatedQualitySystemPrompt).not.toContain("Be ambitious");
    expect(automatedQualitySystemPrompt).not.toContain("Clean design over merely working");
  });

  it("keeps tests draft skeleton guidance", () => {
    expect(automatedReviewTestsSystemPrompt).toContain(
      "Draft skeletons are required when this specialist reports findings",
    );
    expect(automatedReviewTestsSystemPrompt).toContain("draft test skeleton");
    expect(automatedReviewTestsSystemPrompt).toContain("the exact changed behaviour");
    expect(automatedReviewTestsSystemPrompt).toContain("the invariant that should hold");
    expect(automatedReviewTestsSystemPrompt).toContain(
      "the plausible regression the test would catch",
    );
    expect(automatedReviewTestsSystemPrompt).toContain(
      "General calls for more coverage, framework adoption, broad test matrices, or confidence-only tests are not findings",
    );
    expect(automatedReviewTestsSystemPrompt).toContain(
      "real low-impact missing check that still names the changed behaviour, untested state, invariant, and plausible regression",
    );
    expect(automatedReviewTestsSystemPrompt).not.toContain("nice-to-have coverage");
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
