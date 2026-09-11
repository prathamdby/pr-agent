import { CODE_MODE_HOST_IN_FLIGHT, CODE_MODE_MAX_TOOL_CALLS } from "../../settings/index.js";
import { AppError, isAppError } from "../../errors/appError.js";
import { idleAbortSignal } from "../providers/interface.js";
import type { AgentLifecycleEvent } from "../runtime/lifecycleEvents.js";
import type { AgentSessionRole } from "../runtime/types.js";
import type { EvidenceLedger } from "../../review/findings/evidenceLedger.js";
import { CodeModeHostHalt, hostCancelHalt } from "./hostHalt.js";
import type { CodeModeInnerFailureKind, CodeModeToolCall } from "./result.js";
import type { CodeModeCapabilityExecutors, CodeModeWorkspaceToolName } from "./types.js";
import {
  recordMarshalledEvidence,
  toGuestCapabilityResult,
  boundJsonValue,
} from "../execution/marshal.js";
import { utf8ByteLength } from "../execution/json.js";

export type CodeModeCapabilityBridge = {
  readonly invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
  readonly toolCalls: CodeModeToolCall[];
  readonly admittedHostCalls: number;
  readonly completedHostCalls: number;
  readonly transferredBytes: number;
};

const ACCESS_DENIED_CODES = new Set([
  "pr_workspace.path_traversal",
  "ask.sensitive_path_blocked",
  "verification.sensitive_path_blocked",
]);

export function classifyCapabilityFailure(error: unknown): {
  readonly kind: CodeModeInnerFailureKind | "UNKNOWN";
  readonly message: string;
} {
  if (isAppError(error)) {
    if (ACCESS_DENIED_CODES.has(error.code)) {
      return { kind: "ACCESS_DENIED", message: error.message };
    }
    if (error.code === "tool.input_validation_failed") {
      return { kind: "TOOL_INPUT_INVALID", message: error.message };
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/not found|missing from checkout/i.test(message)) {
    return { kind: "FILE_NOT_FOUND", message };
  }
  return { kind: "UNKNOWN", message };
}

function emitInnerTool(
  emit: ((event: AgentLifecycleEvent) => void) | undefined,
  params: {
    readonly tool: string;
    readonly ok: boolean;
    readonly role?: AgentSessionRole;
    readonly provider?: string;
    readonly model?: string;
  },
): void {
  if (!emit) return;
  emit({
    kind: "tool",
    role: params.role ?? "specialist",
    toolName: `codemode.${params.tool}`,
    ok: params.ok,
    provider: params.provider ?? "unknown",
    model: params.model ?? "unknown",
  });
}

export function createCodeModeCapabilityBridge(params: {
  readonly capabilities: CodeModeCapabilityExecutors;
  readonly signal?: AbortSignal;
  readonly emit?: (event: AgentLifecycleEvent) => void;
  readonly role?: AgentSessionRole;
  readonly provider?: string;
  readonly model?: string;
  readonly evidenceLedger?: EvidenceLedger;
  readonly headSha?: string;
}): CodeModeCapabilityBridge {
  const toolCalls: CodeModeToolCall[] = [];
  let admittedCalls = 0;
  let completedCalls = 0;
  let transferredBytes = 0;
  let inFlight = 0;
  const waiters: Array<() => void> = [];

  async function acquireInFlight(signal: AbortSignal): Promise<void> {
    while (inFlight >= CODE_MODE_HOST_IN_FLIGHT) {
      if (signal.aborted) {
        throw hostCancelHalt();
      }
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          reject(hostCancelHalt());
        };
        signal.addEventListener("abort", onAbort, { once: true });
        waiters.push(() => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        });
      });
    }
    inFlight += 1;
  }

  function releaseInFlight(): void {
    inFlight = Math.max(0, inFlight - 1);
    waiters.shift()?.();
  }

  async function invoke(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const signal = params.signal ?? idleAbortSignal();
    if (signal.aborted) {
      throw hostCancelHalt();
    }
    const executor = params.capabilities[name as CodeModeWorkspaceToolName];
    if (!executor) {
      throw new AppError({
        code: "codemode.tool_failure",
        message: `UNKNOWN: capability ${name} is not available`,
        context: { tool: name, kind: "UNKNOWN" },
      });
    }
    if (admittedCalls >= CODE_MODE_MAX_TOOL_CALLS) {
      throw new CodeModeHostHalt(
        "LIMIT_EXCEEDED",
        `Workspace capability call budget exceeded (${CODE_MODE_MAX_TOOL_CALLS})`,
      );
    }
    admittedCalls += 1;
    await acquireInFlight(signal);
    try {
      const output = await executor(args, {
        signal,
        toolCallId: `codemode:${name}:${admittedCalls}`,
        emit: params.emit,
        role: params.role,
        provider: params.provider,
        model: params.model,
      });
      toolCalls.push({ tool: name, status: "completed", input: args });
      completedCalls += 1;
      emitInnerTool(params.emit, {
        tool: name,
        ok: true,
        role: params.role,
        provider: params.provider,
        model: params.model,
      });
      const raw =
        output &&
        typeof output === "object" &&
        "truncated" in output &&
        (output as { truncated?: boolean }).truncated === true
          ? { ...(output as Record<string, unknown>), failureKind: "SEARCH_TRUNCATED" }
          : output;
      const coverage =
        raw && typeof raw === "object" && "coverage" in raw
          ? (raw as { coverage?: unknown }).coverage
          : undefined;
      const bounded = boundJsonValue(raw);
      const guest = toGuestCapabilityResult(bounded.value, bounded.truncation, coverage);
      recordMarshalledEvidence(guest, {
        tool: name,
        ledger: params.evidenceLedger,
        headSha: params.headSha,
      });
      transferredBytes += utf8ByteLength(guest);
      return guest;
    } catch (error) {
      if (error instanceof CodeModeHostHalt) throw error;
      const classified = classifyCapabilityFailure(error);
      toolCalls.push({ tool: name, status: "error", input: args });
      emitInnerTool(params.emit, {
        tool: name,
        ok: false,
        role: params.role,
        provider: params.provider,
        model: params.model,
      });
      throw new AppError({
        code:
          classified.kind === "UNKNOWN"
            ? "codemode.tool_failure"
            : `codemode.${classified.kind.toLowerCase()}`,
        message: `${classified.kind}: ${classified.message}`,
        context: { tool: name, kind: classified.kind },
        cause: error,
      });
    } finally {
      releaseInFlight();
    }
  }

  return {
    invoke,
    toolCalls,
    get admittedHostCalls() {
      return admittedCalls;
    },
    get completedHostCalls() {
      return completedCalls;
    },
    get transferredBytes() {
      return transferredBytes;
    },
  };
}
