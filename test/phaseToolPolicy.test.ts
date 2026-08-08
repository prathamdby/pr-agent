import { describe, expect, it } from "vitest";
import {
  assertPhaseToolAllowed,
  createOrchestratorPhaseRef,
  gateOrchestratorPhaseTool,
  WRONG_PHASE_TOOL_CODE,
} from "../src/review/orchestrator/phaseToolPolicy.js";
import { buildSpecialistBriefTool } from "../src/review/orchestrator/briefTool.js";

describe("phaseToolPolicy", () => {
  it("allows brief only in recon and rejects it in synthesis", () => {
    expect(assertPhaseToolAllowed("recon", "submit_specialist_brief").ok).toBe(true);
    const rejected = assertPhaseToolAllowed("synthesis", "submit_specialist_brief");
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.code).toBe(WRONG_PHASE_TOOL_CODE);
      expect(rejected.allowed).toEqual(["publish_summary"]);
    }
  });

  it("allows publish_thread in judgment and publish_summary in synthesis", () => {
    expect(assertPhaseToolAllowed("judgment", "publish_thread").ok).toBe(true);
    expect(assertPhaseToolAllowed("judgment", "publish_summary").ok).toBe(false);
    expect(assertPhaseToolAllowed("synthesis", "publish_summary").ok).toBe(true);
    expect(assertPhaseToolAllowed("validation_repair", "publish_summary").ok).toBe(true);
  });

  it("gates brief executor before validation and returns structured wrong-phase errors", async () => {
    const phaseRef = createOrchestratorPhaseRef("judgment");
    const brief = buildSpecialistBriefTool(phaseRef);
    const result = await brief.executor({
      prIntent: "x",
      architectureNotes: "",
      riskAreas: [],
      fileMap: "",
      specialistFocus: {
        correctness: "a",
        security: "b",
        quality: "c",
        tests: "d",
      },
    });
    expect(result).toMatchObject({
      accepted: false,
      code: WRONG_PHASE_TOOL_CODE,
      phase: "judgment",
    });
    expect(brief.getBrief()).toBeNull();

    phaseRef.current = "recon";
    const accepted = await brief.executor({
      prIntent: "Add cache policy",
      architectureNotes: "Stable tools",
      riskAreas: [],
      fileMap: "runtime",
      specialistFocus: {
        correctness: "a",
        security: "b",
        quality: "c",
        tests: "d",
      },
    });
    expect(accepted).toEqual({ accepted: true });
    expect(brief.getBrief()?.prIntent).toBe("Add cache policy");
    expect(gateOrchestratorPhaseTool(phaseRef, "submit_specialist_brief").ok).toBe(true);
  });
});
