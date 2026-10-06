import { createHmac, randomUUID } from "node:crypto";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { isPlainObject } from "../../util/typeGuards.js";
import { sessionTraceContext } from "../../traces/recorder.js";
import type { TracePartKind, TraceSpan } from "../../traces/traceTypes.js";
import type { PiSessionCreateParams, PiSessionSendOptions } from "./types.js";
import type { AgentLifecycleEvent } from "./lifecycleEvents.js";
import { exactUsageFromProviderUsage } from "../providers/usageMetadata.js";

export function createSessionTrace(
  params: PiSessionCreateParams,
  model: Model<Api>,
  sessionId: string,
  getAttempts: () => number,
) {
  const ctx =
    params.cfg.traces.mode === "off" ? undefined : sessionTraceContext(params.traceWorkItemId);
  if (!ctx) return undefined;
  const { recorder, execution } = ctx;
  const identity = {
    executionId: execution.span.executionId,
    workItemId: execution.span.workItemId,
    role: params.traceRole ?? params.role,
    provider: model.provider,
    model: model.id,
    specialist: params.specialistId ?? null,
  };
  const session = recorder.span({
    ...identity,
    id: sessionId,
    kind: "session",
    parentId: execution.span.id,
  });
  recorder.openSession(execution);
  const tools = new Map<string, TraceSpan>();
  const fingerprintKey = randomUUID();
  let generation: TraceSpan | undefined;
  let lastGeneration: TraceSpan | undefined;
  let compaction: TraceSpan | undefined;
  let compactionAttemptStart = 0;
  let firstThinking: number | undefined;
  let attemptStart = getAttempts();
  let opts: PiSessionSendOptions | undefined;
  let disposed = false;
  let inputReset = false;
  function emptyInput(): TraceSpan {
    return recorder.span({ ...identity, kind: "generation", parentId: session.id });
  }
  let input = emptyInput();
  function queueInput(kind: TracePartKind, value: unknown): void {
    recorder.part(input, kind, value);
  }
  queueInput("system", {
    system: params.systemPrompt,
    tools: params.tools.map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    })),
  });

  function usage(span: TraceSpan, message: AssistantMessage): void {
    const tokens = message.usage;
    const exact = exactUsageFromProviderUsage(tokens);
    span.input = exact?.inputTokens ?? null;
    span.output = exact?.outputTokens ?? null;
    span.cacheRead = exact?.cacheReadTokens ?? null;
    span.cacheWrite = exact?.cacheWriteTokens ?? null;
    if (isPlainObject(tokens) && typeof tokens.reasoning === "number")
      span.reasoning = tokens.reasoning;
    const rates = Object.values(model.cost);
    if (
      rates.some((cost) => Number.isFinite(cost) && cost > 0) &&
      Number.isFinite(tokens.cost.total) &&
      tokens.cost.total > 0
    ) {
      span.costUsd = tokens.cost.total;
      span.costSource = "catalog";
    }
    span.status =
      message.stopReason === "aborted"
        ? "cancelled"
        : message.stopReason === "error"
          ? "error"
          : "ok";
    span.errorCode =
      span.status === "error" ? "provider_error" : span.status === "cancelled" ? "aborted" : null;
    span.attrs.stop_reason = message.stopReason;
    span.attrs.empty_final_text =
      message.stopReason !== "toolUse" && !contentText(message.content).trim();
    for (const part of message.content) {
      if (part.type === "text") recorder.part(span, "assistant_text", part.text);
      if (part.type === "thinking") recorder.part(span, "thinking", part.thinking);
      if (part.type === "toolCall")
        recorder.part(span, "tool_args", {
          name: part.name,
          id: part.id,
          arguments: part.arguments,
        });
    }
  }

  function adoptInput(): void {
    if (!generation || generation.attrs.input_parts !== undefined) return;
    generation.parts.push(...input.parts);
    Object.assign(generation.attrs, input.attrs);
    generation.attrs.input_parts = generation.parts.length;
    generation.attrs.input_reset = inputReset;
    inputReset = false;
    input = emptyInput();
  }

  function closeGeneration(): void {
    if (!generation) return;
    adoptInput();
    generation.attrs.provider_attempts = getAttempts() - attemptStart;
    // Pi's provider-client retries have no per-attempt agent events.
    generation.attrs.retry_folded = params.cfg.provider.retryMax > 0;
    recorder.finish(generation, execution);
    lastGeneration = generation;
    generation = undefined;
  }

  return {
    sessionId: session.id,
    addSecret: (secret: string | undefined) => recorder.addSecret(secret),
    beginSend(send: PiSessionSendOptions): void {
      opts = send;
      session.phase = send.phase;
      session.attrs.sends = Number(session.attrs.sends ?? 0) + 1;
      if (send.phase === "validation_repair" || send.traceValidationRepair) {
        session.attrs.schema_validation_retries =
          Number(session.attrs.schema_validation_retries ?? 0) + 1;
      }
    },
    event(event: AgentEvent): void {
      if (disposed) return;
      if (event.type === "turn_start") {
        attemptStart = getAttempts();
        generation = recorder.span({
          ...identity,
          kind: "generation",
          parentId: session.id,
          phase: opts?.phase,
        });
        firstThinking = undefined;
        generation.attrs.checkpoint_id = opts?.checkpointId ?? null;
      }
      if (event.type === "message_start") {
        const message = event.message;
        if (message.role === "user" || message.role === "system") {
          if (params.cfg.traces.mode === "content")
            queueInput(
              message.role,
              message.role === "system"
                ? JSON.stringify(message)
                : typeof message.content === "string"
                  ? message.content
                  : JSON.stringify(message.content),
            );
        }
        if (message.role === "assistant") {
          generation ??= recorder.span({
            ...identity,
            kind: "generation",
            parentId: session.id,
            phase: opts?.phase,
          });
          adoptInput();
        }
      }
      if (event.type === "message_update" && generation) {
        const type = event.assistantMessageEvent.type;
        const now = Date.now();
        if (type === "text_delta" || type === "thinking_delta" || type === "toolcall_delta") {
          generation.ttftMs ??= now - generation.startedAt.getTime();
        }
        if (type === "thinking_delta") {
          firstThinking ??= now;
          generation.reasoningMs = now - firstThinking;
        }
      }
      if (event.type === "message_end") {
        if (event.message.role === "assistant" && generation) {
          adoptInput();
          usage(generation, event.message);
          closeGeneration();
        }
        if (event.message.role === "toolResult" && params.cfg.traces.mode === "content") {
          queueInput("tool_result", contentText(event.message.content));
        }
      }
      if (event.type === "tool_execution_start") {
        const tool = recorder.span({
          ...identity,
          kind: "tool",
          parentId: lastGeneration?.id ?? session.id,
          phase: opts?.phase,
        });
        tool.attrs.tool_name =
          params.tools.find((definition) => definition.name === event.toolName)?.name ??
          "unknown_tool";
        tool.attrs.tool_call_id = createHmac("sha256", fingerprintKey)
          .update(event.toolCallId)
          .digest("hex");
        const args: unknown = event.args;
        tool.attrs.call_fingerprint = createHmac("sha256", fingerprintKey)
          .update(
            `${event.toolName}:${JSON.stringify(args, (_key, value: unknown) =>
              isPlainObject(value)
                ? Object.fromEntries(
                    Object.keys(value)
                      .toSorted()
                      .map((key) => [key, value[key]]),
                  )
                : value,
            )}`,
          )
          .digest("hex");
        if (isPlainObject(args) && Array.isArray(args.findings))
          tool.attrs.findings_count = args.findings.length;
        recorder.part(tool, "tool_args", args);
        tools.set(event.toolCallId, tool);
      }
      if (event.type === "tool_execution_end") {
        const tool = tools.get(event.toolCallId);
        if (!tool) return;
        tool.status = event.isError ? "error" : "ok";
        tool.errorCode = event.isError ? "tool_error" : null;
        const result: unknown = event.result;
        recorder.part(tool, "tool_result", result);
        if (isPlainObject(result) && Array.isArray(result.content)) {
          for (const part of result.content) {
            if (!isPlainObject(part) || typeof part.text !== "string") continue;
            try {
              const value: unknown = JSON.parse(part.text);
              if (isPlainObject(value) && (value.accepted === false || value.ok === false)) {
                tool.attrs.validation_rejected = value.accepted === false;
                tool.status = "error";
                tool.errorCode =
                  value.accepted === false ? "schema_validation" : "tool_result_error";
              }
            } catch {
              // A plain-text result is not a validation receipt.
            }
          }
        }
        session.attrs.tools = Number(session.attrs.tools ?? 0) + 1;
        if (tool.status === "ok" && tool.attrs.findings_count != null)
          session.attrs.findings_count = tool.attrs.findings_count;
        session.attrs.completed_host_calls =
          Number(session.attrs.completed_host_calls ?? 0) +
          Number(tool.attrs.completed_host_calls ?? 0);
        recorder.finish(tool, execution);
        tools.delete(event.toolCallId);
      }
    },
    toolMetadata(toolCallId: string, event: AgentLifecycleEvent): void {
      if (event.kind !== "execution") return;
      const tool = tools.get(toolCallId);
      if (!tool) return;
      tool.attrs.admitted_host_calls = event.admittedHostCalls;
      tool.attrs.completed_host_calls = event.completedHostCalls;
      tool.attrs.termination_reason = event.terminationReason;
      tool.attrs.code_mode_budget_hit = event.outcome === "budget";
    },
    endSend(end: string, errorCode?: string): string | undefined {
      if (generation) {
        generation.status = "error";
        generation.errorCode = errorCode ?? "interrupted";
        closeGeneration();
      }
      session.attrs.last_end = end;
      if (end === "tool_budget") {
        session.attrs.tool_round_budget_hits =
          Number(session.attrs.tool_round_budget_hits ?? 0) + 1;
      }
      if (errorCode) {
        session.status = errorCode === "agent.session_aborted" ? "cancelled" : "error";
        session.errorCode = errorCode;
        execution.span.status = session.status;
        execution.span.errorCode = errorCode;
      }
      return lastGeneration?.id;
    },
    beginCompaction(system: string, prompt: string): void {
      compactionAttemptStart = getAttempts();
      compaction = recorder.span({
        ...identity,
        kind: "compaction",
        parentId: session.id,
        phase: opts?.phase,
      });
      recorder.part(compaction, "system", system);
      recorder.part(compaction, "user", prompt);
      session.attrs.compactions = Number(session.attrs.compactions ?? 0) + 1;
    },
    endCompaction(message: AssistantMessage | undefined): void {
      if (!compaction) return;
      if (message) usage(compaction, message);
      else {
        compaction.status = "error";
        compaction.errorCode = "compaction_failed";
      }
      compaction.attrs.provider_attempts = getAttempts() - compactionAttemptStart;
      compaction.attrs.retry_folded = params.cfg.provider.retryMax > 0;
      recorder.finish(compaction, execution);
      compaction = undefined;
      // The next input after compaction contains a new summary. Core emits no
      // user event for it; sessionCompaction supplies the adopted transcript.
      attemptStart = getAttempts();
    },
    compacted(messages: readonly AgentMessage[]): void {
      if (params.cfg.traces.mode !== "content") return;
      input = emptyInput();
      inputReset = true;
      for (const message of messages) {
        if (message.role === "system" || message.role === "user") {
          queueInput(message.role, message);
        } else if (message.role === "toolResult") {
          queueInput("tool_result", message);
        } else if (message.role === "assistant") {
          queueInput("assistant_text", message);
        }
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (generation) {
        generation.status = "cancelled";
        generation.errorCode = "interrupted";
        closeGeneration();
      }
      if (compaction) {
        compaction.status = "cancelled";
        compaction.errorCode = "interrupted";
        recorder.finish(compaction, execution);
        compaction = undefined;
      }
      for (const tool of tools.values()) {
        tool.status = "cancelled";
        tool.errorCode = "interrupted";
        recorder.finish(tool, execution);
      }
      tools.clear();
      recorder.finish(session, execution);
      recorder.closeSession(execution);
      if ("standalone" in ctx) recorder.finishExecution(execution);
    },
  };
}

export type SessionTrace = ReturnType<typeof createSessionTrace>;
