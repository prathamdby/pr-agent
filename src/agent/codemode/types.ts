import type { AgentRunnerToolExecutor } from "../providers/interface.js";

export const CODE_MODE_EXECUTE_NAME = "execute";

export const CODE_MODE_WORKSPACE_TOOL_NAMES = [
  "listChangedFiles",
  "readWorkspaceFile",
  "searchWorkspace",
  "getWorkspaceDiff",
  "getWorkspaceBlame",
  "resolveSymbol",
] as const;

export type CodeModeWorkspaceToolName = (typeof CODE_MODE_WORKSPACE_TOOL_NAMES)[number];

export type CodeModeCapabilityExecutors = Partial<
  Record<CodeModeWorkspaceToolName, AgentRunnerToolExecutor>
>;
