import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { toToolParameters } from "../../agent/tools/toolParams.js";
import type { AgentRunnerToolExecutor } from "../../agent/providers/interface.js";
import { AppError } from "../../errors/appError.js";
import { specialistReportSchema } from "./specialistReport.js";

export const SUBMIT_FINDINGS_REPORT_NAME = "submit_findings_report";

export const SUBMIT_FINDINGS_REPORT_DESCRIPTION =
  "Submit your final findings report. This ends your investigation. Use status `findings` with at least one finding, or `no_findings` with an empty findings array. Keep each finding's file and line range within lines a file read or diff result returned in this session. The server drops findings without that evidence. The first time this happens, the result lists the dropped findings with accepted:false so you can read the lines and resubmit.";

export const SUBMIT_FINDINGS_REPORT_PARAMETERS = toToolParameters(specialistReportSchema);

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

export function buildSpecialistSessionTools(
  workspaceTools: SpecialistWorkspaceTools,
  submit: {
    readonly piTool: PiTool;
    readonly executor: AgentRunnerToolExecutor;
  },
): {
  readonly piTools: readonly PiTool[];
  readonly executors: Record<string, AgentRunnerToolExecutor>;
} {
  if (submit.piTool.name !== SUBMIT_FINDINGS_REPORT_NAME) {
    throw new AppError({
      domain: "review",
      kind: "submit_tool_mismatch",
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
