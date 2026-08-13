import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { toJsonSchema } from "@valibot/to-json-schema";
import type { AgentRunnerToolExecutor } from "../../agent/providers/interface.js";
import { AppError } from "../../errors/appError.js";
import { specialistReportSchema } from "./specialistReport.js";

export const SUBMIT_FINDINGS_REPORT_NAME = "submit_findings_report";

/** Frozen across specialist personas so only system prompts differ. */
export const SUBMIT_FINDINGS_REPORT_DESCRIPTION =
  "Submit the specialist's final findings report exactly once.";

export const SUBMIT_FINDINGS_REPORT_PARAMETERS = toJsonSchema(specialistReportSchema, {
  errorMode: "ignore",
});

export type SpecialistWorkspaceTools = {
  readonly piTools: readonly PiTool[];
  readonly executors: Record<string, AgentRunnerToolExecutor>;
};

export function buildSubmitFindingsReportPiTool(): PiTool {
  return {
    name: SUBMIT_FINDINGS_REPORT_NAME,
    description: SUBMIT_FINDINGS_REPORT_DESCRIPTION,
    parameters: SUBMIT_FINDINGS_REPORT_PARAMETERS,
  };
}

/**
 * Assemble the specialist session tool list. Names, order, descriptions, and schemas
 * are identical for every specialist id; only executors may close over identity.
 */
export function buildSpecialistSessionTools(
  workspaceTools: SpecialistWorkspaceTools,
  submit: {
    readonly piTool: PiTool;
    readonly executor: AgentRunnerToolExecutor;
  },
): SpecialistWorkspaceTools {
  if (submit.piTool.name !== SUBMIT_FINDINGS_REPORT_NAME) {
    throw new AppError({
      code: "review.submit_tool_mismatch",
      message: `expected ${SUBMIT_FINDINGS_REPORT_NAME}, got ${submit.piTool.name}`,
      context: { expected: SUBMIT_FINDINGS_REPORT_NAME, got: submit.piTool.name },
    });
  }
  return {
    piTools: [...workspaceTools.piTools, submit.piTool],
    executors: {
      ...workspaceTools.executors,
      [SUBMIT_FINDINGS_REPORT_NAME]: submit.executor,
    },
  };
}
