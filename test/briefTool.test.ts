import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
  buildSpecialistBriefTool,
  renderBriefMessage,
  specialistBriefSchema,
} from "../src/review/orchestrator/briefTool.js";
import { createOrchestratorPhaseRef } from "../src/review/orchestrator/phaseToolPolicy.js";
import {
  ORCHESTRATOR_RECON_INSTRUCTION,
  orchestratorSystemPrompt,
  renderJudgmentTurn,
  renderSynthesisTurn,
} from "../src/review/orchestrator/prompts/orchestratorPrompts.js";
import {
  SPECIALIST_IDS,
  type SpecialistOutcome,
} from "../src/review/orchestrator/orchestratorTypes.js";
import { resolveDescriptionWritingPolicy } from "../src/agent/description/descriptionWritingPolicy.js";

function validRiskArea() {
  return {
    area: "Incremental publishing",
    files: ["src/review/orchestrator/orchestratorRun.ts"],
    reason: "Published thread batches must survive retries.",
  };
}

function validBrief() {
  return {
    prIntent: "Route reviews through one orchestrator.",
    architectureNotes: "The orchestrator owns recon and synthesis.",
    riskAreas: [validRiskArea()],
    fileMap: "src/review/orchestrator: orchestration and specialist handoff",
    specialistFocus: {
      correctness: "Trace state transitions and failure paths.",
      security: "Inspect trust boundaries and credential handling.",
      quality: "Check module ownership and reader load.",
      tests: "Find missing regression and integration coverage.",
    },
  };
}

describe("buildSpecialistBriefTool", () => {
  it("stores a valid parsed specialist brief", async () => {
    const tool = buildSpecialistBriefTool(createOrchestratorPhaseRef("recon"));
    const brief = validBrief();

    const result = await tool.executor({ ...brief, ignored: "strip me" });

    expect(tool.piTool.name).toBe("submit_specialist_brief");
    expect(result).toEqual({ accepted: true });
    expect(tool.getBrief()).toEqual(brief);
  });

  it("returns formatted errors and stores nothing for malformed or oversized input", async () => {
    const tool = buildSpecialistBriefTool(createOrchestratorPhaseRef("recon"));
    const malformedResult = await tool.executor({ architectureNotes: "missing fields" });

    expect(malformedResult).toEqual({
      accepted: false,
      error: expect.stringContaining("SpecialistBrief validation failed:"),
    });
    expect(tool.getBrief()).toBeNull();

    const acceptedResult = await tool.executor(validBrief());

    expect(acceptedResult).toEqual({ accepted: true });
    expect(tool.getBrief()).toEqual(validBrief());
  });
});

const invalidBriefs = [
  ["empty prIntent", { ...validBrief(), prIntent: "" }],
  ["oversized prIntent", { ...validBrief(), prIntent: "x".repeat(2001) }],
  ["oversized architectureNotes", { ...validBrief(), architectureNotes: "x".repeat(6001) }],
  [
    "too many risk areas",
    { ...validBrief(), riskAreas: Array.from({ length: 13 }, validRiskArea) },
  ],
  [
    "oversized risk area name",
    { ...validBrief(), riskAreas: [{ ...validRiskArea(), area: "x".repeat(201) }] },
  ],
  [
    "too many risk files",
    {
      ...validBrief(),
      riskAreas: [
        {
          ...validRiskArea(),
          files: Array.from({ length: 21 }, (_, index) => `src/file-${index}.ts`),
        },
      ],
    },
  ],
  [
    "oversized risk reason",
    { ...validBrief(), riskAreas: [{ ...validRiskArea(), reason: "x".repeat(501) }] },
  ],
  ["oversized fileMap", { ...validBrief(), fileMap: "x".repeat(6001) }],
  [
    "oversized correctness focus",
    {
      ...validBrief(),
      specialistFocus: { ...validBrief().specialistFocus, correctness: "x".repeat(1501) },
    },
  ],
  [
    "oversized security focus",
    {
      ...validBrief(),
      specialistFocus: { ...validBrief().specialistFocus, security: "x".repeat(1501) },
    },
  ],
  [
    "oversized quality focus",
    {
      ...validBrief(),
      specialistFocus: { ...validBrief().specialistFocus, quality: "x".repeat(1501) },
    },
  ],
  [
    "oversized tests focus",
    {
      ...validBrief(),
      specialistFocus: { ...validBrief().specialistFocus, tests: "x".repeat(1501) },
    },
  ],
] satisfies readonly (readonly [string, ReturnType<typeof validBrief>])[];

describe("specialistBriefSchema", () => {
  it.each(invalidBriefs)("rejects %s", (_name, input) => {
    expect(v.safeParse(specialistBriefSchema, input).success).toBe(false);
  });

  it("accepts every field at its cap", () => {
    const cappedRisk = {
      area: "x".repeat(200),
      files: Array.from({ length: 20 }, (_, index) => `src/file-${index}.ts`),
      reason: "x".repeat(500),
    };

    expect(
      v.safeParse(specialistBriefSchema, {
        prIntent: "x".repeat(2000),
        architectureNotes: "x".repeat(6000),
        riskAreas: Array.from({ length: 12 }, () => cappedRisk),
        fileMap: "x".repeat(6000),
        specialistFocus: {
          correctness: "x".repeat(1500),
          security: "x".repeat(1500),
          quality: "x".repeat(1500),
          tests: "x".repeat(1500),
        },
      }).success,
    ).toBe(true);
  });
});

describe("renderBriefMessage", () => {
  it.each(SPECIALIST_IDS)("renders shared context and only the %s focus", (specialist) => {
    const brief = validBrief();
    const risk = brief.riskAreas[0];
    if (!risk) throw new Error("test brief requires one risk area");
    const riskFile = risk.files[0];
    if (!riskFile) throw new Error("test risk area requires one file");

    const message = renderBriefMessage(brief, specialist);

    expect(message).toContain(brief.prIntent);
    expect(message).toContain(brief.architectureNotes);
    expect(message).toContain(risk.area);
    expect(message).toContain(riskFile);
    expect(message).toContain(risk.reason);
    expect(message).toContain(brief.fileMap);
    for (const focus of SPECIALIST_IDS) {
      if (focus === specialist) {
        expect(message).toContain(brief.specialistFocus[focus]);
      } else {
        expect(message).not.toContain(brief.specialistFocus[focus]);
      }
    }
  });
});

describe("orchestrator prompts", () => {
  it("requires the structured brief during reconnaissance", () => {
    expect(orchestratorSystemPrompt).toContain("submit_specialist_brief");
    expect(ORCHESTRATOR_RECON_INSTRUCTION).toContain("submit_specialist_brief` exactly once");
  });

  it("requires one duplicate-aware publish_thread judgment call and permits zero findings", () => {
    const outcome = {
      kind: "report",
      specialist: "correctness",
      durationMs: 1,
      report: {
        status: "findings",
        findings: [
          {
            severity: "P2",
            file: "src/example.ts",
            startLine: 4,
            endLine: 4,
            title: "Handle the missing value",
            detail: "The changed path dereferences an absent value.",
          },
        ],
      },
    } satisfies Extract<SpecialistOutcome, { readonly kind: "report" }>;

    const prompt = renderJudgmentTurn(outcome);

    expect(prompt).toContain("publish_thread` exactly once");
    expect(prompt).toContain("same-file overlap hints");
    expect(prompt).toContain("zero findings is valid");
    expect(prompt).toContain("commentable right line range");
  });

  it("binds synthesis to accepted placements and partial coverage", () => {
    const prompt = renderSynthesisTurn({
      acceptedFindings: [],
      partialSpecialists: ["security"],
      outcomes: [],
      overviewPolicy: resolveDescriptionWritingPolicy({
        fileCount: 12,
        totalChanges: 500,
        truncated: false,
      }),
      fileCount: 12,
      totalChanges: 500,
      truncated: false,
    });

    expect(prompt).toContain("sole source of review findings");
    expect(prompt).toContain("partial coverage");
    expect(prompt).toContain("publish_summary` exactly once");
    expect(prompt).toContain('"security"');
    expect(prompt).toContain("Hard rule (overview scale: standard)");
    expect(prompt).toContain("Overview scale: standard");
    expect(prompt).toContain("notable risks or contracts");
  });

  it("injects brief overview hard rule for small change sets", () => {
    const prompt = renderSynthesisTurn({
      acceptedFindings: [],
      partialSpecialists: [],
      outcomes: [],
      overviewPolicy: resolveDescriptionWritingPolicy({
        fileCount: 2,
        totalChanges: 40,
        truncated: false,
      }),
      fileCount: 2,
      totalChanges: 40,
      truncated: false,
    });
    expect(prompt).toContain("Hard rule (overview scale: brief)");
    expect(prompt).toContain("what changed and why it matters");
  });

  it("injects detailed overview hard rule for large or truncated change sets", () => {
    const prompt = renderSynthesisTurn({
      acceptedFindings: [],
      partialSpecialists: [],
      outcomes: [],
      overviewPolicy: resolveDescriptionWritingPolicy({
        fileCount: 1,
        totalChanges: 1,
        truncated: true,
      }),
      fileCount: 1,
      totalChanges: 1,
      truncated: true,
    });
    expect(prompt).toContain("Hard rule (overview scale: detailed)");
    expect(prompt).toContain("how key modules or paths interact");
    expect(prompt).toContain("Change set truncated: yes");
  });

  it("documents STE100 and overview scale in the orchestrator system prompt", () => {
    expect(orchestratorSystemPrompt).toContain("## Writing style (ASD-STE100)");
    expect(orchestratorSystemPrompt).toContain("## Review overview (prCharacter)");
    expect(orchestratorSystemPrompt).toContain("Do not report specialist lane status");
  });
});
