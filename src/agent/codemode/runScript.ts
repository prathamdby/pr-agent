import { CODE_MODE_MAX_OUTPUT_BYTES, CODE_MODE_TIMEOUT_MS } from "../../settings/index.js";
import type {
  AgentLifecycleEvent,
  AgentLifecycleExecutionEvent,
} from "../runtime/lifecycleEvents.js";
import type { AgentSessionRole } from "../runtime/types.js";
import type { EvidenceLedger } from "../../review/findings/evidenceLedger.js";
import { combineAbortSignals } from "../providers/abortSignals.js";
import { createCodeModeCapabilityBridge } from "./capabilities.js";
import { isCodeModeHostHalt } from "./hostHalt.js";
import type { CodeModeResult } from "./result.js";
import { boundJsonValue, toGuestCapabilityResult } from "../execution/marshal.js";
import { utf8ByteLength } from "../execution/json.js";
import {
  acquireExecutor,
  createExecutionSessionStore,
  type ExecutionSessionStore,
} from "../execution/index.js";
import type { CodeModeCapabilityExecutors } from "./types.js";
import { randomUUID } from "node:crypto";

export type ExecutionOutcome = AgentLifecycleExecutionEvent["outcome"];

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

function boundExecuteOutput(output: unknown): {
  readonly output: unknown;
  readonly warnings?: ReadonlyArray<string>;
} {
  const bounded = boundJsonValue(output, {
    maxTransferBytes: CODE_MODE_MAX_OUTPUT_BYTES,
  });
  if (bounded.truncation == null) {
    return { output: bounded.value };
  }
  return {
    output: toGuestCapabilityResult(bounded.value, bounded.truncation),
    warnings: [`output truncated (${bounded.truncation.reason})`],
  };
}

export async function runCodeModeScript(params: {
  readonly code: string;
  readonly capabilities: CodeModeCapabilityExecutors;
  readonly signal?: AbortSignal;
  readonly emit?: (event: AgentLifecycleEvent) => void;
  readonly role?: AgentSessionRole;
  readonly provider?: string;
  readonly model?: string;
  readonly session?: ExecutionSessionStore;
  readonly evidenceLedger?: EvidenceLedger;
  readonly headSha?: string;
}): Promise<CodeModeResult> {
  const startedAt = Date.now();
  const session = params.session ?? createExecutionSessionStore();
  const hostAborted = () => params.signal?.aborted === true;
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
      hostAborted(),
    );
    return result;
  };

  const bridge = createCodeModeCapabilityBridge({
    capabilities: params.capabilities,
    signal: params.signal,
    emit: params.emit,
    role: params.role,
    provider: params.provider,
    model: params.model,
    evidenceLedger: params.evidenceLedger,
    headSha: params.headSha,
  });

  if (hostAborted()) {
    session.closeAdmission();
    session.invalidate();
    return finish({
      ok: false,
      error: { code: "TIMEOUT", message: "Code Mode cancelled by host signal" },
      toolCalls: [],
    });
  }

  session.reopenAdmission();
  const generation = session.generation;
  const revision = session.revision;
  const timeout = AbortSignal.timeout(CODE_MODE_TIMEOUT_MS);
  const signal = params.signal != null ? combineAbortSignals([params.signal, timeout]) : timeout;
  const onAbort = () => {
    session.closeAdmission();
    session.invalidate();
  };
  signal.addEventListener("abort", onAbort, { once: true });

  const capabilityNames = Object.keys(params.capabilities);
  const executionId = randomUUID();
  try {
    const lease = await acquireExecutor(signal);
    try {
      const cell = await lease.run({
        code: params.code,
        state: session.data,
        capabilityNames,
        executionId,
        signal,
        isCurrent: () => session.generation === generation && session.admissionOpen,
        hostCall: async (name, args) => {
          if (!session.admissionOpen || session.generation !== generation) {
            throw new Error("Code Mode cancelled by host signal");
          }
          return bridge.invoke(name, args);
        },
      });
      const toolCalls = bridge.toolCalls;
      if (!cell.ok) {
        if (hostAborted()) {
          return finish({
            ok: false,
            error: { code: "TIMEOUT", message: "Code Mode cancelled by host signal" },
            toolCalls: toolCalls.map(({ tool, status }) => ({ tool, status })),
          });
        }
        return finish({
          ok: false,
          error: cell.error,
          toolCalls: toolCalls.map(({ tool, status }) => ({ tool, status })),
        });
      }
      const committed = session.commit(generation, revision, cell.stagedState);
      if (!committed) {
        if (hostAborted()) {
          return finish({
            ok: false,
            error: { code: "TIMEOUT", message: "Code Mode cancelled by host signal" },
            toolCalls: toolCalls.map(({ tool, status }) => ({ tool, status })),
          });
        }
        return finish({
          ok: false,
          error: { code: "EXECUTION_ERROR", message: "Code Mode session state conflict" },
          toolCalls: toolCalls.map(({ tool, status }) => ({ tool, status })),
        });
      }
      const boundedOutput = boundExecuteOutput(cell.output);
      return finish({
        ok: true,
        output: boundedOutput.output,
        toolCalls,
        ...(boundedOutput.warnings ? { warnings: boundedOutput.warnings } : {}),
      });
    } finally {
      lease.release();
    }
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
      return finish({
        ok: false,
        error: {
          code: "TIMEOUT",
          message: hostAborted()
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
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
