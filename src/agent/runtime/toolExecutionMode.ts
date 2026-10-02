import { workspaceToolExecutionMode } from "../tools/workspaceToolset.js";
import { CODE_MODE_EXECUTE_NAME } from "../codemode/types.js";

export const SEQUENTIAL_TOOL_NAMES: ReadonlySet<string> = new Set([
  CODE_MODE_EXECUTE_NAME,
  "submit_findings_report",
  "submit_specialist_brief",
  "publish_thread",
  "publish_summary",
  "submitDescription",
  "submitTriage",
  "submitVerification",
]);

export type ToolExecutionMode = "sequential" | "parallel";

export function toolExecutionMode(toolName: string): ToolExecutionMode | undefined {
  return (
    workspaceToolExecutionMode(toolName) ??
    (SEQUENTIAL_TOOL_NAMES.has(toolName) ? "sequential" : undefined)
  );
}
