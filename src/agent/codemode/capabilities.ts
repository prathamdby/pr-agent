import { CODE_MODE_MAX_TOOL_CALLS } from "../../settings/index.js";
import { AppError, isAppError } from "../../errors/appError.js";
import type { AgentLifecycleEvent } from "../runtime/lifecycleEvents.js";
import type { AgentSessionRole } from "../runtime/types.js";
import { CodeModeHostHalt } from "./hostHalt.js";
import type { CodeModeInnerFailureKind, CodeModeToolCall } from "./result.js";
import { serializeCodeModeValue } from "./serialize.js";
import type { CodeModeCapabilityExecutors, CodeModeWorkspaceToolName } from "./types.js";

export type CodeModeCapabilityBridge = {
  readonly tools: Record<string, (args?: Record<string, unknown>) => Promise<unknown>>;
  readonly toolCalls: CodeModeToolCall[];
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
}): CodeModeCapabilityBridge {
  const toolCalls: CodeModeToolCall[] = [];
  let admittedCalls = 0;
  const tools: Record<string, (args?: Record<string, unknown>) => Promise<unknown>> = {};

  const names = Object.keys(params.capabilities) as CodeModeWorkspaceToolName[];
  for (const name of names) {
    const executor = params.capabilities[name];
    if (!executor) continue;
    tools[name] = async (args: Record<string, unknown> = {}) => {
      if (params.signal?.aborted) {
        throw new CodeModeHostHalt("TIMEOUT", "Code Mode cancelled by host signal");
      }
      if (admittedCalls >= CODE_MODE_MAX_TOOL_CALLS) {
        throw new CodeModeHostHalt(
          "LIMIT_EXCEEDED",
          `Workspace capability call budget exceeded (${CODE_MODE_MAX_TOOL_CALLS})`,
        );
      }
      admittedCalls += 1;
      try {
        const output = await executor(args);
        toolCalls.push({ tool: name, status: "completed", input: args });
        emitInnerTool(params.emit, {
          tool: name,
          ok: true,
          role: params.role,
          provider: params.provider,
          model: params.model,
        });
        if (
          output &&
          typeof output === "object" &&
          "truncated" in output &&
          (output as { truncated?: boolean }).truncated === true
        ) {
          return {
            ...(output as Record<string, unknown>),
            failureKind: "SEARCH_TRUNCATED",
          };
        }
        return serializeCodeModeValue(output);
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
      }
    };
  }

  return { tools, toolCalls };
}
