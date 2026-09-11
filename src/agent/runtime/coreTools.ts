import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { AppError } from "../../errors/appError.js";
import { recordReviewMetric } from "../../review/run/reviewRunMetrics.js";
import {
  combineAbortSignals,
  type AgentRunnerToolExecutor,
  type AgentToolCallContext,
} from "../providers/interface.js";
import { toolExecutionMode } from "./toolExecutionMode.js";

const TERMINAL_SUBMIT_TOOLS: ReadonlySet<string> = new Set([
  "submit_findings_report",
  "submit_specialist_brief",
  "publish_summary",
  "submitDescription",
  "submitTriage",
  "submitVerification",
]);

function toolResultToText(result: unknown): string {
  if (result === undefined) return "";
  return typeof result === "string" ? result : JSON.stringify(result);
}

function toolResultSize(result: unknown): { resultBytes: number; resultCharacters: number } {
  const text = toolResultToText(result);
  return {
    resultCharacters: text.length,
    resultBytes: Buffer.byteLength(text, "utf8"),
  };
}

function safeRecordReviewMetric(event: Parameters<typeof recordReviewMetric>[0]): void {
  try {
    recordReviewMetric(event);
  } catch {
    // metrics are best-effort outside review runs
  }
}

function asToolArgs(args: unknown): Record<string, unknown> {
  if (args !== null && typeof args === "object" && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  return {};
}

function isAcceptedTerminalResult(result: unknown): boolean {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return false;
  const record = result as Record<string, unknown>;
  return record.accepted === true || record.ok === true;
}

export function toCoreTool(
  tool: PiTool,
  executor: AgentRunnerToolExecutor | undefined,
  hostSignal: AbortSignal | undefined,
  refreshBeforeTool?: (toolName: string) => Promise<void>,
): AgentTool {
  const executionMode = toolExecutionMode(tool.name);
  return {
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
          code: "provider.missing_tool_executor",
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
        };
        const result = await executor(asToolArgs(params), ctx);
        const size = toolResultSize(result);
        safeRecordReviewMetric({
          kind: "tool_call",
          name: tool.name,
          ok: true,
          durationMs: Date.now() - startedAt,
          resultBytes: size.resultBytes,
          resultCharacters: size.resultCharacters,
        });
        const payload: AgentToolResult<Record<string, unknown>> = {
          content: [{ type: "text", text: toolResultToText(result) }],
          details: result && typeof result === "object" ? (result as Record<string, unknown>) : {},
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
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  };
}

export function toCoreTools(
  tools: readonly PiTool[],
  executors: Record<string, AgentRunnerToolExecutor>,
  hostSignal: AbortSignal | undefined,
  refreshBeforeTool?: (toolName: string) => Promise<void>,
): AgentTool[] {
  return tools.map((tool) => toCoreTool(tool, executors[tool.name], hostSignal, refreshBeforeTool));
}
