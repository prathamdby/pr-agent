import { workspaceToolExecutionMode } from "../tools/workspaceToolset.ts";
import { CODE_MODE_EXECUTE_NAME } from "../codemode/types.ts";

export const SEQUENTIAL_TOOL_NAMES: ReadonlySet<string> = new Set([
  CODE_MODE_EXECUTE_NAME,
  "submit_findings_report",
  "submit_specialist_brief",
  "publish_thread",
  "declare_duplicate",
  "publish_summary",
  "submitDescription",
  "submitTriage",
  "submitVerification",
]);

export type ToolExecutionMode = "sequential" | "parallel";

export function toolExecutionMode(toolName: string) {
  return ((pinnedReturn: ToolExecutionMode | undefined) => pinnedReturn)(
    workspaceToolExecutionMode(toolName) ??
      (SEQUENTIAL_TOOL_NAMES.has(toolName) ? "sequential" : undefined),
  );
}
