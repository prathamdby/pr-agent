import type { Tool as PiTool } from "@earendil-works/pi-ai";
import * as v from "valibot";
import type { AgentRunnerToolExecutor } from "../providers/interface.js";
import { type LocalTool, toExecutor, toPiTool } from "../tools/defineWorkspaceTool.js";
import { runCodeModeScript } from "./runScript.js";
import type { CodeModeResult } from "./result.js";
import { CODE_MODE_EXECUTE_NAME, type CodeModeCapabilityExecutors } from "./types.js";

export {
  CODE_MODE_EXECUTE_NAME,
  CODE_MODE_WORKSPACE_TOOL_NAMES,
  type CodeModeCapabilityExecutors,
  type CodeModeWorkspaceToolName,
} from "./types.js";

const EXECUTE_DESCRIPTION = [
  "Run a focused JavaScript program against the local PR workspace in one turn.",
  "Author JavaScript only. The last expression is the return value.",
  "Call workspace operations as `await tools.listChangedFiles()`, `await tools.readWorkspaceFile({ path })`, `await tools.searchWorkspace({ query })`, `await tools.getWorkspaceDiff({ path })`, `await tools.getWorkspaceBlame({ path })`, and `await tools.resolveSymbol({ name })`.",
  "Use `await Promise.all(...)` for concurrent inspections.",
  "`fetch`, `require`, `import`, `process`, `fs`, and timers are unavailable.",
  "Return compact summaries. Do not dump raw search or file contents back unless a finding needs a specific excerpt.",
  "Terminal reports stay on sibling tools (`submit_findings_report`, `submit_specialist_brief`, publish actions). Do not submit findings from this script.",
].join(" ");

export function buildCodeModeExecuteTool(params: {
  readonly capabilities: CodeModeCapabilityExecutors;
}): {
  readonly piTool: PiTool;
  readonly executor: AgentRunnerToolExecutor;
} {
  const tool: LocalTool = {
    description: EXECUTE_DESCRIPTION,
    schema: v.object({
      code: v.pipe(v.string(), v.minLength(1)),
    }),
    run: async ({ code }, ctx): Promise<CodeModeResult> =>
      runCodeModeScript({
        code,
        capabilities: params.capabilities,
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
