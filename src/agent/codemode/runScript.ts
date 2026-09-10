import * as acorn from "acorn";
import { CODE_MODE_TIMEOUT_MS } from "../../settings/index.js";
import type {
  AgentLifecycleEvent,
  AgentLifecycleExecutionEvent,
} from "../runtime/lifecycleEvents.js";
import type { AgentSessionRole } from "../runtime/types.js";
import { createCodeModeCapabilityBridge } from "./capabilities.js";
import { isCodeModeHostHalt } from "./hostHalt.js";
import { evaluateProgram } from "./evaluate.js";
import type { CodeModeResult } from "./result.js";
import { serializeCodeModeValue } from "./serialize.js";
import type { CodeModeCapabilityExecutors } from "./types.js";

export type ExecutionOutcome = AgentLifecycleExecutionEvent["outcome"];

function utf8ByteLength(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
  } catch {
    return 0;
  }
}

export function executionOutcomeFromResult(
  result: CodeModeResult,
  hostAborted: boolean,
): {
  readonly outcome: ExecutionOutcome;
  readonly errorCode?: string;
  readonly terminationReason: string;
} {
  if (result.ok) {
    return { outcome: "success", terminationReason: "success" };
  }
  const code = result.error.code;
  if (code === "TIMEOUT" && hostAborted) {
    return { outcome: "cancelled", errorCode: "timeout", terminationReason: "host_cancel" };
  }
  if (code === "TIMEOUT") {
    return { outcome: "budget", errorCode: "timeout", terminationReason: "timeout" };
  }
  if (code === "EXECUTION_BUDGET_EXCEEDED") {
    return {
      outcome: "budget",
      errorCode: "execution_budget_exceeded",
      terminationReason: "budget",
    };
  }
  if (code === "LIMIT_EXCEEDED") {
    return { outcome: "budget", errorCode: "limit_exceeded", terminationReason: "limit" };
  }
  return {
    outcome: "execution_failure",
    errorCode: code.toLowerCase(),
    terminationReason: code.toLowerCase(),
  };
}

function emitExecutionResult(
  params: {
    readonly emit?: (event: AgentLifecycleEvent) => void;
    readonly role?: AgentSessionRole;
    readonly provider?: string;
    readonly model?: string;
  },
  result: CodeModeResult,
  stats: {
    readonly durationMs: number;
    readonly admittedHostCalls: number;
    readonly completedHostCalls: number;
    readonly transferredBytes: number;
  },
  hostAborted: boolean,
): void {
  if (!params.emit || !params.role || !params.provider || !params.model) return;
  const classified = executionOutcomeFromResult(result, hostAborted);
  const outputBytes = result.ok
    ? utf8ByteLength(result.output)
    : utf8ByteLength(result.error.message);
  params.emit({
    kind: "execution",
    role: params.role,
    provider: params.provider,
    model: params.model,
    outcome: classified.outcome,
    ...(classified.errorCode ? { errorCode: classified.errorCode } : {}),
    durationMs: stats.durationMs,
    admittedHostCalls: stats.admittedHostCalls,
    completedHostCalls: stats.completedHostCalls,
    transferredBytes: stats.transferredBytes,
    outputBytes,
    terminationReason: classified.terminationReason,
  });
}

export async function runCodeModeScript(params: {
  readonly code: string;
  readonly capabilities: CodeModeCapabilityExecutors;
  readonly signal?: AbortSignal;
  readonly emit?: (event: AgentLifecycleEvent) => void;
  readonly role?: AgentSessionRole;
  readonly provider?: string;
  readonly model?: string;
}): Promise<CodeModeResult> {
  const startedAt = Date.now();
  const bridge = createCodeModeCapabilityBridge({
    capabilities: params.capabilities,
    signal: params.signal,
    emit: params.emit,
    role: params.role,
    provider: params.provider,
    model: params.model,
  });

  const finish = (result: CodeModeResult): CodeModeResult => {
    emitExecutionResult(
      params,
      result,
      {
        durationMs: Date.now() - startedAt,
        admittedHostCalls: bridge.admittedHostCalls,
        completedHostCalls: bridge.completedHostCalls,
        transferredBytes: bridge.transferredBytes,
      },
      params.signal?.aborted === true,
    );
    return result;
  };

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
    return finish({
      ok: false,
      error: {
        code: "SYNTAX_ERROR",
        message: error instanceof Error ? error.message : String(error),
        ...(loc?.line != null ? { line: loc.line } : {}),
      },
      toolCalls: bridge.toolCalls.map(({ tool, status }) => ({ tool, status })),
    });
  }

  const timeout = AbortSignal.timeout(CODE_MODE_TIMEOUT_MS);
  const signal = params.signal != null ? AbortSignal.any([params.signal, timeout]) : timeout;

  try {
    const output = await evaluateProgram(parsed, {
      tools: bridge.tools,
      signal,
    });
    return finish({
      ok: true,
      output: serializeCodeModeValue(output),
      toolCalls: bridge.toolCalls,
    });
  } catch (error) {
    const toolCalls = bridge.toolCalls.map(({ tool, status }) => ({ tool, status }));
    if (isCodeModeHostHalt(error)) {
      return finish({
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.line != null ? { line: error.line } : {}),
        },
        toolCalls,
      });
    }
    if (signal.aborted) {
      const cancelledByHost = params.signal?.aborted === true;
      return finish({
        ok: false,
        error: {
          code: "TIMEOUT",
          message: cancelledByHost
            ? "Code Mode cancelled by host signal"
            : `Code Mode exceeded ${CODE_MODE_TIMEOUT_MS}ms`,
        },
        toolCalls,
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    const isToolFailure =
      /ACCESS_DENIED|FILE_NOT_FOUND|SEARCH_TRUNCATED|TOOL_INPUT_INVALID|codemode\./.test(message);
    return finish({
      ok: false,
      error: {
        code: isToolFailure ? "TOOL_FAILURE" : "EXECUTION_ERROR",
        message,
      },
      toolCalls,
    });
  }
}
