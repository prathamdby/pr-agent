import { describe, expect, it } from "vitest";
import {
  buildSpecialistBriefTool,
  renderBriefMessage,
  specialistBriefSchema,
  type SpecialistBrief,
} from "../src/review/orchestrator/briefTool.js";
import { SPECIALIST_IDS } from "../src/review/orchestrator/specialistReport.js";

function makeBrief(overrides: Partial<SpecialistBrief> = {}): SpecialistBrief {
  return {
    prIntent: "Fix webhook retries.",
    architectureNotes: "Worker fan-out over durable queues.",
    riskAreas: [
      {
        area: "token refresh",
        files: ["src/agentWork/durableJob.ts"],
        reason: "Long runs may publish with a stale token.",
      },
    ],
    fileMap: "src/review/orchestrator/* — new V2 units",
    specialistFocus: {
      correctness: "Focus on race conditions in the completion pump.",
      security: "Focus on token leakage in publish tools.",
      quality: "Focus on dead code left from lens collapse.",
      tests: "Focus on missing red-green coverage for budget exhaustion.",
    },
    ...overrides,
  };
}

describe("specialistBriefSchema", () => {
  it("accepts a well-formed brief", () => {
    expect(specialistBriefSchema.parse(makeBrief()).prIntent).toBe("Fix webhook retries.");
  });

  it("enforces string and array caps", () => {
    expect(specialistBriefSchema.safeParse(makeBrief({ prIntent: "" })).success).toBe(false);
    expect(specialistBriefSchema.safeParse(makeBrief({ prIntent: "x".repeat(2001) })).success).toBe(
      false,
    );
    expect(
      specialistBriefSchema.safeParse(makeBrief({ architectureNotes: "x".repeat(6001) })).success,
    ).toBe(false);
    expect(
      specialistBriefSchema.safeParse(
        makeBrief({
          riskAreas: Array.from({ length: 13 }, (_, i) => ({
            area: `a${i}`,
            files: ["f.ts"],
            reason: "r",
          })),
        }),
      ).success,
    ).toBe(false);
    expect(
      specialistBriefSchema.safeParse(
        makeBrief({
          specialistFocus: {
            ...makeBrief().specialistFocus,
            security: "x".repeat(1501),
          },
        }),
      ).success,
    ).toBe(false);
  });
});

describe("renderBriefMessage", () => {
  it("includes shared sections and only the selected specialist focus", () => {
    const brief = makeBrief();
    for (const specialist of SPECIALIST_IDS) {
      const message = renderBriefMessage(brief, specialist);
      expect(message).toContain(brief.prIntent);
      expect(message).toContain(brief.architectureNotes);
      expect(message).toContain(brief.fileMap);
      expect(message).toContain(brief.riskAreas[0]?.area ?? "");
      expect(message).toContain(brief.specialistFocus[specialist]);
      for (const other of SPECIALIST_IDS) {
        if (other === specialist) continue;
        expect(message).not.toContain(brief.specialistFocus[other]);
      }
    }
  });
});

describe("buildSpecialistBriefTool", () => {
  it("stores a validated brief and returns formatted errors on invalid input", async () => {
    const tool = buildSpecialistBriefTool();
    expect(tool.getBrief()).toBeNull();

    const rejected = await tool.executor({ prIntent: "" });
    expect(rejected).toEqual(
      expect.objectContaining({ accepted: false, error: expect.stringContaining("validation") }),
    );
    expect(tool.getBrief()).toBeNull();

    const accepted = await tool.executor(makeBrief());
    expect(accepted).toEqual({ accepted: true, value: makeBrief() });
    expect(tool.getBrief()).toEqual(makeBrief());
  });
});
