import { describe, expect, it } from "vitest";
import { renderBriefMessage } from "../src/review/orchestrator/briefTool.js";
import { SPECIALIST_IDS } from "../src/review/orchestrator/orchestratorTypes.js";

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
