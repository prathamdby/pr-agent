import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { AgentRunnerToolExecutor } from "../../agent/providers/interface.js";
import { specialistReportSchema } from "./specialistReport.js";

export const SUBMIT_FINDINGS_REPORT_NAME = "submit_findings_report";

/** Frozen across specialist personas so only system prompts differ. */
export const SUBMIT_FINDINGS_REPORT_DESCRIPTION =
  "Submit the specialist's final findings report exactly once.";

export const SUBMIT_FINDINGS_REPORT_PARAMETERS = z.toJSONSchema(specialistReportSchema);

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
): {
  readonly piTools: readonly PiTool[];
  readonly executors: Record<string, AgentRunnerToolExecutor>;
  readonly toolNames: readonly string[];
} {
  if (submit.piTool.name !== SUBMIT_FINDINGS_REPORT_NAME) {
    throw new Error(`expected ${SUBMIT_FINDINGS_REPORT_NAME}, got ${submit.piTool.name}`);
  }
  const piTools = [...workspaceTools.piTools, submit.piTool];
  return {
    piTools,
    executors: {
      ...workspaceTools.executors,
      [SUBMIT_FINDINGS_REPORT_NAME]: submit.executor,
    },
    toolNames: piTools.map((tool) => tool.name),
  };
}

/** Serialize tool definitions for equality tests (excludes executors). */
export function specialistToolDefinitionsJson(piTools: readonly PiTool[]): string {
  return JSON.stringify(
    piTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  );
}
