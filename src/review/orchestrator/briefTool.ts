import type { Tool as PiTool } from "@earendil-works/pi-ai";
import * as v from "valibot";
import { toJsonSchema } from "@valibot/to-json-schema";
import type { AgentRunnerToolExecutor } from "../../agent/providers/interface.js";
import { parseToolInput } from "../../agent/tools/parseToolInput.js";
import type { SpecialistId } from "./orchestratorTypes.js";
import { assertPhaseToolAllowed, type OrchestratorPhaseRef } from "./phaseToolPolicy.js";

export const specialistBriefSchema = v.object({
  prIntent: v.pipe(v.string(), v.minLength(1), v.maxLength(2000)),
  architectureNotes: v.pipe(v.string(), v.maxLength(6000)),
  riskAreas: v.pipe(
    v.array(
      v.object({
        area: v.pipe(v.string(), v.maxLength(200)),
        files: v.pipe(v.array(v.string()), v.maxLength(20)),
        reason: v.pipe(v.string(), v.maxLength(500)),
      }),
    ),
    v.maxLength(12),
  ),
  fileMap: v.pipe(v.string(), v.maxLength(6000)),
  specialistFocus: v.object({
    correctness: v.pipe(v.string(), v.maxLength(1500)),
    security: v.pipe(v.string(), v.maxLength(1500)),
    quality: v.pipe(v.string(), v.maxLength(1500)),
    tests: v.pipe(v.string(), v.maxLength(1500)),
  }),
});

export type SpecialistBrief = v.InferOutput<typeof specialistBriefSchema>;

export type SpecialistBriefTool = {
  readonly piTool: PiTool;
  readonly executor: AgentRunnerToolExecutor;
  readonly getBrief: () => SpecialistBrief | null;
  readonly getValidationError: () => string | null;
  readonly clearValidationError: () => void;
};

export function buildSpecialistBriefTool(phaseRef: OrchestratorPhaseRef): SpecialistBriefTool {
  let brief: SpecialistBrief | null = null;
  let validationError: string | null = null;
  const piTool: PiTool = {
    name: "submit_specialist_brief",
    description: "Submit the structured specialist brief after completing PR reconnaissance.",
    parameters: toJsonSchema(specialistBriefSchema, { errorMode: "ignore" }),
  };
  const executor: AgentRunnerToolExecutor = async (args) => {
    const gate = assertPhaseToolAllowed(phaseRef.current, "submit_specialist_brief");
    if (!gate.ok) {
      validationError = gate.error;
      return {
        accepted: false,
        code: gate.code,
        phase: gate.phase,
        allowed: gate.allowed,
        error: gate.error,
      };
    }
    const parsed = parseToolInput(specialistBriefSchema, args, {
      toolName: "submit_specialist_brief",
      errorTitle: "SpecialistBrief validation failed:",
    });
    if (!parsed.ok) {
      validationError = parsed.error;
      return { accepted: false, error: validationError };
    }
    brief = parsed.value;
    validationError = null;
    return { accepted: true };
  };

  return {
    piTool,
    executor,
    getBrief: () => brief,
    getValidationError: () => validationError,
    clearValidationError: () => {
      validationError = null;
    },
  };
}

export function renderBriefMessage(brief: SpecialistBrief, specialist: SpecialistId): string {
  return [
    "Investigate this pull request using the specialist brief below.",
    "",
    "## PR intent",
    brief.prIntent,
    "",
    "## Architecture notes",
    brief.architectureNotes,
    "",
    "## Risk areas",
    ...brief.riskAreas.map(
      (risk) =>
        `- ${risk.area}\n  Files: ${risk.files.length > 0 ? risk.files.join(", ") : "(none)"}\n  Reason: ${risk.reason}`,
    ),
    "",
    "## File map",
    brief.fileMap,
    "",
    `## ${specialist} focus`,
    brief.specialistFocus[specialist],
  ].join("\n");
}
