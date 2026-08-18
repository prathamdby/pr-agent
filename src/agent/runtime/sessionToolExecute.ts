import { captureEvent, isAnalyticsEnabled } from "../../analytics/index.js";
import { AppError } from "../../errors/appError.js";
import { recordReviewMetric } from "../../review/run/reviewRunMetrics.js";
import type { AgentRunnerToolExecutor } from "../providers/interface.js";
import { formatUnknownToolError } from "../tools/laneToolContract.js";
import { safeEmitAgentEvent, type SessionToolEvents } from "./agentEventSink.js";
import type { AgentSessionPhase, AgentSessionRole } from "./types.js";

export const AGENT_TOOL_CALLED_EVENT = "agent tool called";

export type SessionToolTrace = {
  readonly role: AgentSessionRole;
  readonly workType: string;
  readonly phase: () => AgentSessionPhase | undefined;
  readonly validToolNames: readonly string[];
  readonly events?: SessionToolEvents;
};

export function sessionWorkTypeForRole(role: AgentSessionRole): string {
  switch (role) {
    case "orchestrator":
    case "specialist":
    case "ci_summary":
      return "review";
    case "ask":
      return "ask";
    case "description":
      return "description";
    case "triage":
      return "triage";
    case "verification":
      return "verification";
    default: {
      const _exhaustive: never = role;
      return _exhaustive;
    }
  }
}

function safeRecordReviewMetric(event: Parameters<typeof recordReviewMetric>[0]): void {
  try {
    recordReviewMetric(event);
  } catch {
    // metrics are best-effort outside review runs
  }
}

function captureAgentToolCalled(params: {
  readonly toolName: string;
  readonly role: AgentSessionRole;
  readonly workType: string;
  readonly phase: string | undefined;
  readonly ok: boolean;
  readonly duration: number;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly installationId: number;
}): void {
  try {
    captureEvent({
      distinctId: `installation:${params.installationId}`,
      event: AGENT_TOOL_CALLED_EVENT,
      properties: {
        tool_name: params.toolName,
        session_role: params.role,
        work_type: params.workType,
        phase: params.phase,
        ok: params.ok,
        duration: params.duration,
        owner: params.owner,
        repo: params.repo,
        pr_number: params.prNumber,
      },
    });
  } catch {
    // Analytics must never fail or delay tool execution.
  }
}

function emitToolTraces(params: {
  readonly toolName: string;
  readonly ok: boolean;
  readonly duration: number;
  readonly trace?: SessionToolTrace;
}): void {
  const trace = params.trace;
  const events = trace?.events;
  if (!trace || !events) return;
  const phase = trace.phase();
  const workType = trace.workType;
  safeEmitAgentEvent(events.context, events.cfg, {
    workItemId: events.context.workItemId,
    installationId: events.context.installationId,
    owner: events.context.owner,
    repo: events.context.repo,
    prNumber: events.context.prNumber,
    sessionRole: trace.role,
    eventKind: "tool",
    phase: phase ?? null,
    toolName: params.toolName,
    ok: params.ok,
    detail: { duration: params.duration, workType },
  });
  if (!isAnalyticsEnabled()) return;
  captureAgentToolCalled({
    toolName: params.toolName,
    role: trace.role,
    workType,
    phase,
    ok: params.ok,
    duration: params.duration,
    owner: events.context.owner,
    repo: events.context.repo,
    prNumber: events.context.prNumber,
    installationId: events.context.installationId,
  });
}

export async function invokeSessionTool(params: {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly executor?: AgentRunnerToolExecutor;
  readonly refreshBeforeTool?: (toolName: string) => Promise<void>;
  readonly trace?: SessionToolTrace;
}): Promise<unknown> {
  const startedAt = Date.now();
  if (!params.executor) {
    const duration = Date.now() - startedAt;
    const message = formatUnknownToolError(params.toolName, params.trace?.validToolNames ?? []);
    safeRecordReviewMetric({
      kind: "tool_call",
      name: params.toolName,
      ok: false,
      durationMs: duration,
      errorMessage: message,
    });
    emitToolTraces({
      toolName: params.toolName,
      ok: false,
      duration,
      trace: params.trace,
    });
    throw new AppError({
      code: "provider.missing_tool_executor",
      message,
      context: {
        toolName: params.toolName,
        ...(params.trace?.validToolNames ? { validTools: params.trace.validToolNames } : {}),
      },
    });
  }

  try {
    if (params.refreshBeforeTool) {
      await params.refreshBeforeTool(params.toolName);
    }
    const result = await params.executor(params.args);
    const duration = Date.now() - startedAt;
    const text =
      result === undefined ? "" : typeof result === "string" ? result : JSON.stringify(result);
    safeRecordReviewMetric({
      kind: "tool_call",
      name: params.toolName,
      ok: true,
      durationMs: duration,
      resultBytes: Buffer.byteLength(text, "utf8"),
      resultCharacters: text.length,
    });
    emitToolTraces({
      toolName: params.toolName,
      ok: true,
      duration,
      trace: params.trace,
    });
    return result;
  } catch (error) {
    const duration = Date.now() - startedAt;
    safeRecordReviewMetric({
      kind: "tool_call",
      name: params.toolName,
      ok: false,
      durationMs: duration,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    emitToolTraces({
      toolName: params.toolName,
      ok: false,
      duration,
      trace: params.trace,
    });
    throw error;
  }
}
