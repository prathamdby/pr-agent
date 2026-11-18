import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { AppError } from "../../errors/appError.ts";
import { recordReviewMetric } from "../../review/run/reviewRunMetrics.ts";
import {
  combineAbortSignals,
  type AgentRunnerToolExecutor,
  type AgentToolCallContext,
  type HostCallOutcome,
} from "../providers/interface.ts";
import { toolExecutionMode } from "./toolExecutionMode.ts";
import { errorMessage } from "../../errors/errorMessage.ts";
import { isRecord } from "../../util/typeGuards.ts";
import type { AgentLifecycleEvent } from "./lifecycleEvents.ts";

const TERMINAL_SUBMIT_TOOLS: ReadonlySet<string> = new Set([
  "submit_findings_report",
  "submit_specialist_brief",
  "publish_summary",
  "submitDescription",
  "submitTriage",
  "submitVerification",
]);

function toolResultToText(result: unknown) {
  if (result === undefined) return ((pinnedReturn: string) => pinnedReturn)("");
  return ((pinnedReturn: string) => pinnedReturn)(
    typeof result === "string" ? result : JSON.stringify(result),
  );
}

function toolResultSize(result: unknown) {
  const text = toolResultToText(result);
  return ((pinnedReturn: { resultBytes: number; resultCharacters: number }) => pinnedReturn)({
    resultCharacters: text.length,
    resultBytes: Buffer.byteLength(text, "utf8"),
  });
}

function safeRecordReviewMetric(event: Parameters<typeof recordReviewMetric>[0]) {
  try {
    recordReviewMetric(event);
  } catch {}
}

function asToolArgs(args: unknown) {
  if (isRecord(args)) {
    return ((pinnedReturn: Record<string, unknown>) => pinnedReturn)(args);
  }
  return ((pinnedReturn: Record<string, unknown>) => pinnedReturn)({});
}

function isAcceptedTerminalResult(result: unknown) {
  if (!isRecord(result)) return ((pinnedReturn: boolean) => pinnedReturn)(false);
  return ((pinnedReturn: boolean) => pinnedReturn)(result.accepted === true || result.ok === true);
}

function isRejectedTerminalResult(result: unknown) {
  if (!isRecord(result)) return ((pinnedReturn: boolean) => pinnedReturn)(false);
  return ((pinnedReturn: boolean) => pinnedReturn)(
    (result.accepted === false || result.ok === false) && typeof result.error === "string",
  );
}

export type ToolCallTrace = {
  readonly toolMetadata: (toolCallId: string, event: AgentLifecycleEvent) => void;
  readonly hostCall: (
    toolCallId: string,
    tool: string,
    input: unknown,
  ) => ((outcome: HostCallOutcome) => void) | undefined;
};

export function toCoreTool(
  tool: PiTool,
  executor: AgentRunnerToolExecutor | undefined,
  hostSignal: AbortSignal | undefined,
  refreshBeforeTool?: (toolName: string) => Promise<void>,
  trace?: ToolCallTrace,
) {
  const executionMode = toolExecutionMode(tool.name);
  return ((pinnedReturn: AgentTool) => pinnedReturn)({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    prepareArguments: asToolArgs,
    ...(executionMode ? { executionMode } : {}),
    execute: async (toolCallId, params, loopSignal) => {
      const startedAt = Date.now();
      if (!executor) {
        safeRecordReviewMetric({
          kind: "tool_call",
          name: tool.name,
          ok: false,
          durationMs: Date.now() - startedAt,
          errorMessage: `No executor registered for tool ${tool.name}`,
        });
        throw new AppError({
          domain: "provider",
          kind: "missing_tool_executor",
          message: `No executor registered for tool ${tool.name}`,
          context: { toolName: tool.name },
        });
      }
      try {
        if (refreshBeforeTool) {
          await refreshBeforeTool(tool.name);
        }
        const ctx: AgentToolCallContext = {
          signal: combineAbortSignals([loopSignal, hostSignal]),
          toolCallId,
          ...(trace
            ? {
                emit: (event: AgentLifecycleEvent) => trace.toolMetadata(toolCallId, event),
                traceHostCall: (name: string, input: unknown) =>
                  trace.hostCall(toolCallId, name, input),
              }
            : {}),
        };
        const result = await executor(asToolArgs(params), ctx);
        if (TERMINAL_SUBMIT_TOOLS.has(tool.name) && isRejectedTerminalResult(result)) {
          throw new AppError({
            domain: "tool",
            kind: "submit_rejected",
            message: toolResultToText(result),
            context: { toolName: tool.name },
          });
        }
        const size = toolResultSize(result);
        safeRecordReviewMetric({
          kind: "tool_call",
          name: tool.name,
          ok: true,
          durationMs: Date.now() - startedAt,
          resultBytes: size.resultBytes,
          resultCharacters: size.resultCharacters,
        });
        const payload: AgentToolResult<unknown> = {
          content: [{ type: "text", text: toolResultToText(result) }],
          details: result && typeof result === "object" ? result : {},
          ...(TERMINAL_SUBMIT_TOOLS.has(tool.name) && isAcceptedTerminalResult(result)
            ? { terminate: true }
            : {}),
        };
        return payload;
      } catch (error) {
        safeRecordReviewMetric({
          kind: "tool_call",
          name: tool.name,
          ok: false,
          durationMs: Date.now() - startedAt,
          errorMessage: errorMessage(error),
        });
        throw error;
      }
    },
  });
}

export function toCoreTools(
  tools: readonly PiTool[],
  executors: Record<string, AgentRunnerToolExecutor>,
  hostSignal: AbortSignal | undefined,
  refreshBeforeTool?: (toolName: string) => Promise<void>,
  trace?: ToolCallTrace,
) {
  return ((pinnedReturn: AgentTool[]) => pinnedReturn)(
    tools.map((tool) =>
      toCoreTool(tool, executors[tool.name], hostSignal, refreshBeforeTool, trace),
    ),
  );
}
