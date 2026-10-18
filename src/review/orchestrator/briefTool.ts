import type { Tool as PiTool } from "@earendil-works/pi-ai";
import * as v from "valibot";
import { toToolParameters } from "../../agent/tools/toolParams.ts";
import type { AgentRunnerToolExecutor } from "../../agent/providers/interface.ts";
import { parseToolInput } from "../../agent/tools/parseToolInput.ts";
import { assertPhaseToolAllowed, type OrchestratorPhaseRef } from "./phaseToolPolicy.ts";

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

export type SpecialistBriefRenderOptions = {
  readonly pullRequestMetadata?: {
    readonly title: string;
    readonly body: string | null;
  };
};

export function buildSpecialistBriefTool(
  phaseRef: OrchestratorPhaseRef,
  options?: {
    readonly initialBrief?: SpecialistBrief;
    readonly onAccepted?: (brief: SpecialistBrief) => Promise<void>;
  },
): {
  readonly piTool: PiTool;
  readonly executor: AgentRunnerToolExecutor;
  readonly getBrief: () => SpecialistBrief | null;
  readonly getValidationError: () => string | null;
  readonly clearValidationError: () => void;
} {
  let brief: SpecialistBrief | null = options?.initialBrief ?? null;
  let validationError: string | null = null;
  const piTool: PiTool = {
    name: "submit_specialist_brief",
    description:
      "Submit the reconnaissance brief that every specialist receives. Call it once your investigation is done. Risk areas and focus notes are hypotheses for the specialists to verify, so name files and reasons rather than conclusions. A rejected call returns the validation error; fix the named fields and call again.",
    parameters: toToolParameters(specialistBriefSchema),
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
    await options?.onAccepted?.(parsed.value);
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
