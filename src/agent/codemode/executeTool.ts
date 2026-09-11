import type { Tool as PiTool } from "@earendil-works/pi-ai";
import * as v from "valibot";
import type { AgentRunnerToolExecutor } from "../providers/interface.js";
import type { EvidenceLedger } from "../../review/findings/evidenceLedger.js";
import { type LocalTool, toExecutor, toPiTool } from "../tools/defineWorkspaceTool.js";
import {
  createExecutionSessionStore,
  type ExecutionSessionStore,
} from "../execution/sessionStore.js";
import { runCodeModeScript } from "./runScript.js";
import type { CodeModeResult } from "./result.js";
import { renderExecuteDescription } from "./guestCatalogue.js";
import { CODE_MODE_EXECUTE_NAME, type CodeModeCapabilityExecutors } from "./types.js";

export {
  CODE_MODE_EXECUTE_NAME,
  CODE_MODE_WORKSPACE_TOOL_NAMES,
  type CodeModeCapabilityExecutors,
  type CodeModeWorkspaceToolName,
} from "./types.js";

export function buildCodeModeExecuteTool(params: {
  readonly capabilities: CodeModeCapabilityExecutors;
  readonly session?: ExecutionSessionStore;
  readonly evidenceLedger?: EvidenceLedger;
  readonly headSha?: string;
}): {
  readonly piTool: PiTool;
  readonly executor: AgentRunnerToolExecutor;
} {
  const session = params.session ?? createExecutionSessionStore();
  const tool: LocalTool = {
    description: renderExecuteDescription(params.capabilities),
    schema: v.object({
      code: v.pipe(v.string(), v.minLength(1)),
    }),
    run: async ({ code }, ctx): Promise<CodeModeResult> =>
      runCodeModeScript({
        code,
        capabilities: params.capabilities,
        session,
        evidenceLedger: params.evidenceLedger,
        headSha: params.headSha,
        signal: ctx?.signal,
        emit: ctx?.emit,
        role: ctx?.role,
        provider: ctx?.provider,
        model: ctx?.model,
      }),
  };
  return {
    piTool: toPiTool(CODE_MODE_EXECUTE_NAME, tool),
    executor: toExecutor(CODE_MODE_EXECUTE_NAME, tool),
  };
}
