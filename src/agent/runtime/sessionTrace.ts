import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { isPlainObject } from "../../util/typeGuards.js";
import { logWarn } from "../../evlog.js";
import {
  openTraceSession,
  type TraceDraft,
  type TraceHandle,
  type TraceStatus,
} from "../../traces/recorder.js";
import type { PiSessionCreateParams, PiSessionSendOptions } from "./types.js";
import type { AgentLifecycleEvent } from "./lifecycleEvents.js";
import { exactUsageFromProviderUsage } from "../providers/usageMetadata.js";

type TraceTurn = { readonly role: string; readonly content: unknown };

type OpenGeneration = {
  readonly id: string;
  readonly startedAt: number;
  readonly attemptStart: number;
  phase?: string;
  ttftMs?: number;
  reasoningMs?: number;
  firstThinking?: number;
};

type OpenTool = {
  readonly id: string;
  readonly startedAt: number;
  readonly name: string;
  readonly args: unknown;
  readonly phase?: string;
  extra: Record<string, string | number | boolean | null>;
};

type OpenCompaction = {
  readonly id: string;
  readonly startedAt: number;
  readonly attemptStart: number;
  readonly system: string;
  readonly prompt: string;
  readonly phase?: string;
};

function createRecording(
  params: PiSessionCreateParams,
  model: Model<Api>,
  sessionId: string,
  getAttempts: () => number,
) {
  const opened = openTraceSession({ provider: model.provider, model: model.id });
  if (!opened) return undefined;
  const recording: TraceHandle = opened;
  const role = params.traceRole ?? params.role;
  const specialist = params.specialistId;
  const toolDefs = params.tools.map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }));
  const startedAt = Date.now();
  const basis: TraceTurn[] = [{ role: "system", content: params.systemPrompt }];
  const tools = new Map<string, OpenTool>();
  let generation: OpenGeneration | undefined;
  let lastGenerationId: string | undefined;
  let compaction: OpenCompaction | undefined;
  let opts: PiSessionSendOptions | undefined;
  let disposed = false;
  let sessionStatus: TraceStatus = "ok";
  let sessionError: string | undefined;
  let lastEnd: string | undefined;

  function appendTurn(turn: TraceTurn): void {
    basis.push(turn);
  }

  function rememberUserOrSystem(message: Extract<AgentMessage, { role: "user" | "system" }>): void {
    const content = message.content;
    if (
      message.role === "system" &&
      content === params.systemPrompt &&
      basis[0]?.role === "system" &&
      basis[0].content === params.systemPrompt
    ) {
      return;
    }
    appendTurn({ role: message.role, content });
  }

  function identity(phase: string | undefined): Pick<TraceDraft, "phase" | "role" | "specialist"> {
    return {
      ...(phase != null ? { phase } : {}),
      role,
      ...(specialist != null ? { specialist } : {}),
    };
  }

  function usageFields(
    message: AssistantMessage,
  ): Pick<
    TraceDraft,
    | "inputTokens"
    | "outputTokens"
    | "cacheReadTokens"
    | "cacheWriteTokens"
    | "cacheWrite1hTokens"
    | "totalTokens"
    | "costUsd"
    | "status"
    | "isError"
    | "error"
    | "extra"
  > {
    const exact = exactUsageFromProviderUsage(message.usage);
    const rates = Object.values(model.cost);
    const catalogPriced = rates.some((cost) => Number.isFinite(cost) && cost > 0);
    const cost = message.usage.cost.total;
    const status: TraceStatus =
      message.stopReason === "aborted"
        ? "cancelled"
        : message.stopReason === "error"
          ? "error"
          : "ok";
    const reasoning =
      isPlainObject(message.usage) && typeof message.usage.reasoning === "number"
        ? message.usage.reasoning
        : undefined;
    return {
      ...(exact?.inputTokens != null ? { inputTokens: exact.inputTokens } : {}),
      ...(exact?.outputTokens != null ? { outputTokens: exact.outputTokens } : {}),
      ...(exact?.cacheReadTokens != null ? { cacheReadTokens: exact.cacheReadTokens } : {}),
      ...(exact?.cacheWriteTokens != null ? { cacheWriteTokens: exact.cacheWriteTokens } : {}),
      ...(exact?.cacheWrite1hTokens != null
        ? { cacheWrite1hTokens: exact.cacheWrite1hTokens }
        : {}),
      ...(exact?.totalTokens != null ? { totalTokens: exact.totalTokens } : {}),
      ...(catalogPriced && Number.isFinite(cost) && cost > 0 ? { costUsd: cost } : {}),
      status,
      ...(status === "error" ? { isError: true, error: "provider_error" } : {}),
      extra: {
        stop_reason: message.stopReason,
        raw_stop_reason: message.rawStopReason ?? null,
        effort: message.providerThinkingLevel ?? null,
        empty_final_text: message.stopReason !== "toolUse" && !contentText(message.content).trim(),
        ...(reasoning != null ? { reasoning_tokens: reasoning } : {}),
      },
    };
  }

  function closeGeneration(status: TraceStatus, error?: string, output?: AssistantMessage): void {
    if (!generation) return;
    const current = generation;
    generation = undefined;
    lastGenerationId = current.id;
    const measured = output ? usageFields(output) : undefined;
    const resolved = measured?.status ?? status;
    recording.emit({
      event: "$ai_generation",
      spanId: current.id,
      parentId: sessionId,
      spanName: "generation",
      provider: model.provider,
      model: model.id,
      status: resolved,
      latencyMs: Date.now() - current.startedAt,
      ...(current.ttftMs != null ? { ttftMs: current.ttftMs } : {}),
      ...(current.reasoningMs != null ? { reasoningMs: current.reasoningMs } : {}),
      ...(resolved === "error"
        ? { isError: true, error: measured?.error ?? error ?? "interrupted" }
        : {}),
      ...identity(current.phase),
      ...(measured?.inputTokens != null ? { inputTokens: measured.inputTokens } : {}),
      ...(measured?.outputTokens != null ? { outputTokens: measured.outputTokens } : {}),
      ...(measured?.cacheReadTokens != null ? { cacheReadTokens: measured.cacheReadTokens } : {}),
      ...(measured?.cacheWriteTokens != null
        ? { cacheWriteTokens: measured.cacheWriteTokens }
        : {}),
      ...(measured?.cacheWrite1hTokens != null
        ? { cacheWrite1hTokens: measured.cacheWrite1hTokens }
        : {}),
      ...(measured?.totalTokens != null ? { totalTokens: measured.totalTokens } : {}),
      ...(measured?.costUsd != null ? { costUsd: measured.costUsd } : {}),
      input: basis.map((turn) => ({ role: turn.role, content: turn.content })),
      outputChoices: output ? outputChoices(output) : [],
      tools: toolDefs,
      extra: {
        ...measured?.extra,
        provider_attempts: getAttempts() - current.attemptStart,
        retry_folded: params.cfg.provider.retryMax > 0,
        checkpoint_id: opts?.checkpointId ?? null,
      },
    });
    if (output) appendTurn({ role: "assistant", content: outputChoices(output) });
  }

  function finishTool(tool: OpenTool, status: TraceStatus, result: unknown, error?: string): void {
    recording.emit({
      event: "$ai_span",
      spanId: tool.id,
      parentId: lastGenerationId ?? sessionId,
      spanName: `tool:${tool.name}`,
      provider: model.provider,
      model: model.id,
      status,
      latencyMs: Date.now() - tool.startedAt,
      ...(status === "error" ? { isError: true, error: error ?? "tool_error" } : {}),
      ...identity(tool.phase),
      inputState: tool.args,
      outputState: result,
      ...(Object.keys(tool.extra).length > 0 ? { extra: tool.extra } : {}),
    });
  }

  function finishCompaction(message: AssistantMessage | undefined, status: TraceStatus): void {
    if (!compaction) return;
    const current = compaction;
    compaction = undefined;
    const measured = message ? usageFields(message) : undefined;
    const resolved =
      measured?.status === "error" || measured?.status === "cancelled" ? measured.status : status;
    recording.emit({
      event: "$ai_generation",
      spanId: current.id,
      parentId: sessionId,
      spanName: "compaction",
      provider: model.provider,
      model: model.id,
      status: resolved,
      latencyMs: Date.now() - current.startedAt,
      ...(resolved === "error"
        ? { isError: true, error: measured?.error ?? "compaction_failed" }
        : {}),
      ...identity(current.phase),
      ...(measured?.inputTokens != null ? { inputTokens: measured.inputTokens } : {}),
      ...(measured?.outputTokens != null ? { outputTokens: measured.outputTokens } : {}),
      ...(measured?.cacheReadTokens != null ? { cacheReadTokens: measured.cacheReadTokens } : {}),
      ...(measured?.cacheWriteTokens != null
        ? { cacheWriteTokens: measured.cacheWriteTokens }
        : {}),
      ...(measured?.cacheWrite1hTokens != null
        ? { cacheWrite1hTokens: measured.cacheWrite1hTokens }
        : {}),
      ...(measured?.totalTokens != null ? { totalTokens: measured.totalTokens } : {}),
      ...(measured?.costUsd != null ? { costUsd: measured.costUsd } : {}),
      input: [
        { role: "system", content: current.system },
        { role: "user", content: current.prompt },
      ],
      ...(message ? { outputChoices: outputChoices(message) } : {}),
      tools: toolDefs,
      extra: {
        ...measured?.extra,
        provider_attempts: getAttempts() - current.attemptStart,
        retry_folded: params.cfg.provider.retryMax > 0,
      },
    });
  }

  return {
    addSecret: (secret: string | undefined) => recording.addSecret(secret),
    beginSend: (send: PiSessionSendOptions): void => {
      opts = send;
    },
    event: (event: AgentEvent): void => {
      if (disposed) return;
      if (event.type === "turn_start") {
        generation = {
          id: randomUUID(),
          startedAt: Date.now(),
          attemptStart: getAttempts(),
          ...(opts?.phase != null ? { phase: opts.phase } : {}),
        };
      }
      if (event.type === "message_start") {
        const message = event.message;
        if (message.role === "user" || message.role === "system") rememberUserOrSystem(message);
        if (message.role === "assistant") {
          generation ??= {
            id: randomUUID(),
            startedAt: Date.now(),
            attemptStart: getAttempts(),
            ...(opts?.phase != null ? { phase: opts.phase } : {}),
          };
        }
      }
      if (event.type === "message_update" && generation) {
        const type = event.assistantMessageEvent.type;
        const now = Date.now();
        if (type === "text_delta" || type === "thinking_delta" || type === "toolcall_delta") {
          generation.ttftMs ??= now - generation.startedAt;
        }
        if (type === "thinking_delta") {
          generation.firstThinking ??= now;
          generation.reasoningMs = now - generation.firstThinking;
        }
      }
      if (event.type === "message_end") {
        if (event.message.role === "assistant") closeGeneration("ok", undefined, event.message);
        if (event.message.role === "toolResult") {
          appendTurn({ role: "tool", content: contentText(event.message.content) });
        }
      }
      if (event.type === "tool_execution_start") {
        const known = params.tools.find((definition) => definition.name === event.toolName)?.name;
        const tool: OpenTool = {
          id: randomUUID(),
          startedAt: Date.now(),
          name: known ?? "unknown_tool",
          args: event.args,
          ...(opts?.phase != null ? { phase: opts.phase } : {}),
          extra: {},
        };
        if (isPlainObject(event.args) && Array.isArray(event.args.findings)) {
          tool.extra.findings_count = event.args.findings.length;
        }
        tools.set(event.toolCallId, tool);
      }
      if (event.type === "tool_execution_end") {
        const tool = tools.get(event.toolCallId);
        if (!tool) return;
        const failure = toolFailure(event.result, event.isError);
        finishTool(tool, failure.status, event.result, failure.error);
        tools.delete(event.toolCallId);
      }
    },
    toolMetadata: (toolCallId: string, event: AgentLifecycleEvent): void => {
      if (event.kind !== "execution") return;
      const tool = tools.get(toolCallId);
      if (!tool) return;
      tool.extra.admitted_host_calls = event.admittedHostCalls;
      tool.extra.completed_host_calls = event.completedHostCalls;
      tool.extra.termination_reason = event.terminationReason;
      tool.extra.code_mode_budget_hit = event.outcome === "budget";
    },
    endSend: (end: string, errorCode?: string): string | undefined => {
      lastEnd = end;
      if (generation) closeGeneration("error", errorCode ?? "interrupted");
      if (errorCode) {
        const status = errorCode === "agent.session_aborted" ? "cancelled" : "error";
        sessionStatus = status;
        sessionError = errorCode;
        recording.fail(status, errorCode);
      }
      return lastGenerationId;
    },
    beginCompaction: (system: string, prompt: string): void => {
      compaction = {
        id: randomUUID(),
        startedAt: Date.now(),
        attemptStart: getAttempts(),
        system,
        prompt,
        ...(opts?.phase != null ? { phase: opts.phase } : {}),
      };
    },
    endCompaction: (message: AssistantMessage | undefined): void => {
      finishCompaction(message, message ? "ok" : "error");
    },
    compacted: (messages: readonly AgentMessage[]): void => {
      basis.length = 0;
      for (const message of messages) basis.push(turnFromMessage(message));
    },
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      if (generation) closeGeneration("cancelled");
      if (compaction) finishCompaction(undefined, "cancelled");
      for (const tool of tools.values()) finishTool(tool, "cancelled", undefined);
      tools.clear();
      recording.emit({
        event: "$ai_span",
        spanId: sessionId,
        parentId: recording.executionSpanId,
        spanName: "session",
        provider: model.provider,
        model: model.id,
        status: sessionStatus,
        latencyMs: Date.now() - startedAt,
        ...(sessionStatus === "error" ? { isError: true, error: sessionError ?? "error" } : {}),
        ...identity(opts?.phase),
        ...(lastEnd != null ? { extra: { last_end: lastEnd } } : {}),
      });
      recording.closeOwnedExecution();
    },
  };
}

function outputChoices(message: AssistantMessage): unknown[] {
  const choices: unknown[] = [];
  for (const part of message.content) {
    if (part.type === "text") choices.push({ type: "text", text: part.text });
    else if (part.type === "thinking") choices.push({ type: "thinking", thinking: part.thinking });
    else if (part.type === "toolCall") {
      choices.push({ type: "toolCall", name: part.name, id: part.id, arguments: part.arguments });
    }
  }
  return choices;
}

function turnFromMessage(message: AgentMessage): TraceTurn {
  switch (message.role) {
    case "system":
    case "user":
      return {
        role: message.role,
        content: typeof message.content === "string" ? message.content : message.content,
      };
    case "assistant":
      return { role: "assistant", content: outputChoices(message) };
    case "toolResult":
      return { role: "tool", content: contentText(message.content) };
    default: {
      const exhaustive: never = message;
      return exhaustive;
    }
  }
}

function toolFailure(
  result: unknown,
  isError: boolean,
): { readonly status: TraceStatus; readonly error?: string } {
  let status: TraceStatus = isError ? "error" : "ok";
  let error = isError ? (plainError(result) ?? "tool_error") : undefined;
  if (isPlainObject(result) && Array.isArray(result.content)) {
    for (const part of result.content) {
      if (!isPlainObject(part) || typeof part.text !== "string") continue;
      try {
        const value: unknown = JSON.parse(part.text);
        if (!isPlainObject(value) || (value.accepted !== false && value.ok !== false)) continue;
        status = "error";
        error =
          typeof value.error === "string"
            ? value.error
            : typeof value.message === "string"
              ? value.message
              : value.accepted === false
                ? "schema_validation"
                : "tool_result_error";
      } catch {
        // A plain-text result is not a validation receipt.
      }
    }
  }
  return error != null ? { status, error } : { status };
}

function plainError(result: unknown): string | undefined {
  if (!isPlainObject(result)) return undefined;
  if (typeof result.error === "string") return result.error;
  if (typeof result.message === "string") return result.message;
  return undefined;
}

export type SessionTrace = NonNullable<ReturnType<typeof createRecording>>;

function observe<T>(run: () => T): T | undefined {
  try {
    return run();
  } catch {
    logWarn("agent_trace_observer_failed");
    return undefined;
  }
}

function protect<Args extends unknown[], Result>(record: (...args: Args) => Result) {
  return (...args: Args) => observe(() => record(...args));
}

const noTrace: SessionTrace = {
  addSecret: () => undefined,
  beginSend: () => undefined,
  event: () => undefined,
  toolMetadata: () => undefined,
  endSend: () => undefined,
  beginCompaction: () => undefined,
  endCompaction: () => undefined,
  compacted: () => undefined,
  dispose: () => undefined,
};

export function createSessionTrace(
  params: PiSessionCreateParams,
  model: Model<Api>,
  sessionId: string,
  getAttempts: () => number,
): SessionTrace {
  const recording = observe(() => createRecording(params, model, sessionId, getAttempts));
  if (!recording) return noTrace;
  return {
    addSecret: protect(recording.addSecret),
    beginSend: protect(recording.beginSend),
    event: protect(recording.event),
    toolMetadata: protect(recording.toolMetadata),
    endSend: protect(recording.endSend),
    beginCompaction: protect(recording.beginCompaction),
    endCompaction: protect(recording.endCompaction),
    compacted: protect(recording.compacted),
    dispose: protect(recording.dispose),
  };
}
