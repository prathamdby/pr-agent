import type { Tool as PiTool } from "@earendil-works/pi-ai";
import type { AgentRunnerToolExecutor } from "../providers/interface.js";
import type { EvidenceLedger } from "../../review/findings/evidenceLedger.js";
import { createExecutionSessionStore } from "../execution/sessionStore.js";
import { buildCodeModeExecuteTool } from "./executeTool.js";
import { CODE_MODE_EXECUTE_NAME, CODE_MODE_WORKSPACE_TOOL_NAMES } from "./types.js";
import type { CodeModeCapabilityExecutors } from "./types.js";

export type ToolBundle = {
  readonly piTools: readonly PiTool[];
  readonly executors: Record<string, AgentRunnerToolExecutor>;
};

const HIDDEN_TOOL_NAMES = new Set<string>(CODE_MODE_WORKSPACE_TOOL_NAMES);

export function pickCodeModeCapabilities(
  executors: Record<string, AgentRunnerToolExecutor>,
): CodeModeCapabilityExecutors {
  const capabilities: CodeModeCapabilityExecutors = {};
  for (const name of CODE_MODE_WORKSPACE_TOOL_NAMES) {
    const executor = executors[name];
    if (executor) capabilities[name] = executor;
  }
  return capabilities;
}

export function hideWorkspaceToolsBehindCodeMode(
  bundle: ToolBundle,
  options?: {
    readonly evidenceLedger?: EvidenceLedger;
    readonly headSha?: string;
  },
): ToolBundle {
  const execute = buildCodeModeExecuteTool({
    capabilities: pickCodeModeCapabilities(bundle.executors),
    session: createExecutionSessionStore(),
    evidenceLedger: options?.evidenceLedger,
    headSha: options?.headSha,
  });
  return {
    piTools: [
      execute.piTool,
      ...bundle.piTools.filter((tool) => !HIDDEN_TOOL_NAMES.has(tool.name)),
    ],
    executors: {
      ...bundle.executors,
      [CODE_MODE_EXECUTE_NAME]: execute.executor,
    },
  };
}
