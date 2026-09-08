import * as acorn from "acorn";
import { CODE_MODE_TIMEOUT_MS } from "../../settings/index.js";
import type { AgentLifecycleEvent } from "../runtime/lifecycleEvents.js";
import type { AgentSessionRole } from "../runtime/types.js";
import { createCodeModeCapabilityBridge } from "./capabilities.js";
import { isCodeModeHostHalt } from "./hostHalt.js";
import { evaluateProgram } from "./evaluate.js";
import type { CodeModeResult } from "./result.js";
import { serializeCodeModeValue } from "./serialize.js";
import type { CodeModeCapabilityExecutors } from "./types.js";

export async function runCodeModeScript(params: {
  readonly code: string;
  readonly capabilities: CodeModeCapabilityExecutors;
  readonly signal?: AbortSignal;
  readonly emit?: (event: AgentLifecycleEvent) => void;
  readonly role?: AgentSessionRole;
  readonly provider?: string;
  readonly model?: string;
}): Promise<CodeModeResult> {
  const bridge = createCodeModeCapabilityBridge({
    capabilities: params.capabilities,
    signal: params.signal,
    emit: params.emit,
    role: params.role,
    provider: params.provider,
    model: params.model,
  });

  let parsed: acorn.Program;
  try {
    parsed = acorn.parse(params.code, {
      ecmaVersion: "latest",
      sourceType: "script",
      locations: true,
      allowAwaitOutsideFunction: true,
    }) as acorn.Program;
  } catch (error) {
    const loc =
      error instanceof SyntaxError && "loc" in error
        ? (error as SyntaxError & { loc?: { line?: number } }).loc
        : undefined;
    return {
      ok: false,
      error: {
        code: "SYNTAX_ERROR",
        message: error instanceof Error ? error.message : String(error),
        ...(loc?.line != null ? { line: loc.line } : {}),
      },
      toolCalls: bridge.toolCalls.map(({ tool, status }) => ({ tool, status })),
    };
  }

  const timeout = AbortSignal.timeout(CODE_MODE_TIMEOUT_MS);
  const signal = params.signal != null ? AbortSignal.any([params.signal, timeout]) : timeout;

  try {
    const output = await evaluateProgram(parsed, {
      tools: bridge.tools,
      signal,
    });
    return {
      ok: true,
      output: serializeCodeModeValue(output),
      toolCalls: bridge.toolCalls,
    };
  } catch (error) {
    const toolCalls = bridge.toolCalls.map(({ tool, status }) => ({ tool, status }));
    if (isCodeModeHostHalt(error)) {
      return {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.line != null ? { line: error.line } : {}),
        },
        toolCalls,
      };
    }
    if (signal.aborted) {
      const cancelledByHost = params.signal?.aborted === true;
      return {
        ok: false,
        error: {
          code: "TIMEOUT",
          message: cancelledByHost
            ? "Code Mode cancelled by host signal"
            : `Code Mode exceeded ${CODE_MODE_TIMEOUT_MS}ms`,
        },
        toolCalls,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    const isToolFailure =
      /ACCESS_DENIED|FILE_NOT_FOUND|SEARCH_TRUNCATED|TOOL_INPUT_INVALID|codemode\./.test(message);
    return {
      ok: false,
      error: {
        code: isToolFailure ? "TOOL_FAILURE" : "EXECUTION_ERROR",
        message,
      },
      toolCalls,
    };
  }
}
