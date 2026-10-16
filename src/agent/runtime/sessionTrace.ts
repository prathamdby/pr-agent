import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { isPlainObject } from "../../util/typeGuards.js";
import { logWarn } from "../../evlog.js";
import {
  boundText,
  boundTraceValue,
  findingSnapshots,
  safeJson,
  sha256Hex,
  toPostHogOutputChoices,
  TRACE_CONTENT_TRUNCATED,
  TRACE_ERROR_CHARS,
  TRACE_FINDING_LIMIT,
  TRACE_HASH_PREFIX,
  TRACE_LAST_TURNS,
  TRACE_MESSAGE_CHARS,
  TRACE_SYSTEM_CHARS,
  TRACE_TOOL_STATE_CHARS,
  type FindingSnapshot,
  type PostHogMessage,
  type PostHogPart,
} from "../../traces/aiContent.js";
import {
  openTraceSession,
  type TraceDraft,
  type TraceHandle,
  type TraceStatus,
} from "../../traces/recorder.js";
import type { PiSessionCreateParams, PiSessionSendOptions } from "./types.js";
import type { AgentLifecycleEvent } from "./lifecycleEvents.js";
import { exactUsageFromProviderUsage } from "../providers/usageMetadata.js";
import type { HostCallOutcome } from "../providers/interface.js";
import { CODE_MODE_MAX_TOOL_CALLS } from "../../settings/index.js";

const HOST_CALL_INPUT_CHARS = 2_048;
const HOST_CALL_PREVIEW_CHARS = 4_096;
const REPEAT_TOP = 3;

type RepeatEntry = { readonly tool: string; readonly hash: string; count: number };

type ToolBody = {
  readonly name: string;
  readonly status: TraceStatus;
  readonly input_sha256: string;
  readonly code_sha256?: string;
  readonly input: unknown;
  readonly output: unknown;
};

type HostCallRecord = {
  readonly tool: string;
  readonly input: unknown;
  readonly startedAt: number;
  outcome?: HostCallOutcome;
  endedAt?: number;
};

type OpenGeneration = {
  readonly id: string;
  readonly startedAt: number;
  readonly attemptStart: number;
  readonly turnIndex: number;
  phase?: string;
  ttftMs?: number;
  reasoningMs?: number;
  firstThinking?: number;
  streamed?: AssistantMessage;
};

type OpenTool = {
  readonly id: string;
  readonly startedAt: number;
  readonly name: string;
  readonly args: unknown;
  readonly phase?: string;
  readonly hostCalls: HostCallRecord[];
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
    type: "function" as const,
    function: {
      name,
      description: boundText(redactText(description), 1_024).text,
      parameters,
    },
  }));
  const startedAt = Date.now();
  const basis: PostHogMessage[] = [
    {
      role: "system",
      content: boundText(redactText(params.systemPrompt), TRACE_SYSTEM_CHARS).text,
    },
  ];
  const tools = new Map<string, OpenTool>();
  const partialFindings: FindingSnapshot[] = [];
  let generation: OpenGeneration | undefined;
  let lastGenerationId: string | undefined;
  let compaction: OpenCompaction | undefined;
  let opts: PiSessionSendOptions | undefined;
  let disposed = false;
  let sessionStatus: TraceStatus = "ok";
  let sessionError: string | undefined;
  let sessionErrorDetail: string | undefined;
  let lastEnd: string | undefined;
  let turns = 0;
  let toolCalls = 0;
  let hostCallCount = 0;
  let toolMs = 0;
  let modelMs = 0;
  let lastActivity = startedAt;
  let lastTool: string | undefined;
  let lastToolBody: ToolBody | undefined;
  const hostCallKeys = new Map<string, RepeatEntry>();
  const toolCallKeys = new Map<string, number>();
  const codeKeys = new Map<string, number>();

  function redactText(text: string): string {
    const value = recording.redact(text);
    return typeof value === "string" ? value : "";
  }

  function errorDetail(
    code: string,
    message: string,
  ): { readonly code: string; readonly message: string } {
    return { code, message: boundText(redactText(message), TRACE_ERROR_CHARS).text };
  }

  function toolCallKey(
    name: string,
    input: unknown,
  ): { readonly key: string; readonly hash: string } {
    const hash = sha256Hex(safeJson(recording.redact(input)));
    return { key: `${name}:${hash}`, hash };
  }

  function noteCode(args: unknown): string | undefined {
    const redacted = recording.redact(args);
    if (!isPlainObject(redacted) || typeof redacted.code !== "string") return undefined;
    const hash = sha256Hex(redacted.code);
    codeKeys.set(hash, (codeKeys.get(hash) ?? 0) + 1);
    return hash;
  }

  function noteFindings(value: unknown): void {
    for (const finding of findingSnapshots(recording.redact(value))) {
      const key = `${finding.file}:${finding.startLine ?? ""}:${finding.title}`;
      if (
        partialFindings.some((item) => `${item.file}:${item.startLine ?? ""}:${item.title}` === key)
      ) {
        continue;
      }
      if (partialFindings.length >= TRACE_FINDING_LIMIT) return;
      partialFindings.push(finding);
    }
  }

  function toolBody(name: string, status: TraceStatus, args: unknown, output: unknown): ToolBody {
    const redactedArgs = recording.redact(args);
    const code =
      isPlainObject(redactedArgs) && typeof redactedArgs.code === "string"
        ? redactedArgs.code
        : undefined;
    return {
      name,
      status,
      input_sha256: sha256Hex(safeJson(redactedArgs)),
      ...(code != null ? { code_sha256: sha256Hex(code) } : {}),
      input: boundTraceValue(redactedArgs, TRACE_MESSAGE_CHARS, TRACE_TOOL_STATE_CHARS),
      output: boundTraceValue(
        recording.redact(output),
        TRACE_MESSAGE_CHARS,
        TRACE_TOOL_STATE_CHARS,
      ),
    };
  }

  function openGeneration(): OpenGeneration {
    const turnIndex = turns;
    turns += 1;
    return {
      id: randomUUID(),
      startedAt: Date.now(),
      attemptStart: getAttempts(),
      turnIndex,
      ...(opts?.phase != null ? { phase: opts.phase } : {}),
    };
  }

  function loopCounters(now: number): Record<string, string | number | boolean | null> {
    let repeatHostCalls = 0;
    for (const entry of hostCallKeys.values()) repeatHostCalls += entry.count - 1;
    let repeatToolCalls = 0;
    for (const count of toolCallKeys.values()) repeatToolCalls += count - 1;
    const repeatTop = [...hostCallKeys.values()]
      .filter((entry) => entry.count > 1)
      .toSorted((left, right) => right.count - left.count)
      .slice(0, REPEAT_TOP)
      .map((entry) => `${entry.tool}:${entry.hash.slice(0, TRACE_HASH_PREFIX)}:${entry.count}`)
      .join(",");
    const repeatCodeTop = [...codeKeys.entries()]
      .filter((entry) => entry[1] > 1)
      .toSorted((left, right) => right[1] - left[1])
      .slice(0, REPEAT_TOP)
      .map(([hash, count]) => `${hash.slice(0, TRACE_HASH_PREFIX)}:${count}`)
      .join(",");
    return {
      turns,
      tool_calls: toolCalls,
      host_calls: hostCallCount,
      repeat_host_calls: repeatHostCalls,
      repeat_top: repeatTop,
      repeat_code_top: repeatCodeTop,
      repeat_tool_calls: repeatToolCalls,
      tool_ms_total: toolMs,
      model_ms_total: modelMs,
      ms_since_last_activity: now - lastActivity,
      last_tool: lastTool ?? null,
      last_end: lastEnd ?? null,
      error_code: sessionError ?? null,
      ...(sessionErrorDetail != null
        ? { error_message: boundText(redactText(sessionErrorDetail), 200).text }
        : {}),
    };
  }

  function appendTurn(turn: PostHogMessage): void {
    basis.push(turn);
  }

  function rememberUserOrSystem(message: Extract<AgentMessage, { role: "user" | "system" }>): void {
    const content = message.content;
    if (
      message.role === "system" &&
      content === params.systemPrompt &&
      basis[0]?.role === "system"
    ) {
      return;
    }
    appendTurn(messageFromUserOrSystem(message.role, content));
  }

  function messageFromUserOrSystem(
    messageRole: "user" | "system",
    content: unknown,
  ): PostHogMessage {
    const limit = messageRole === "system" ? TRACE_SYSTEM_CHARS : TRACE_MESSAGE_CHARS;
    if (typeof content === "string")
      return { role: messageRole, content: boundText(redactText(content), limit).text };
    if (!Array.isArray(content)) {
      return { role: messageRole, content: boundText(redactText(safeJson(content)), limit).text };
    }
    const parts: PostHogPart[] = [];
    for (const part of content) {
      if (isPlainObject(part) && part.type === "text" && typeof part.text === "string") {
        parts.push({ type: "text", text: boundText(redactText(part.text), limit).text });
      } else if (isPlainObject(part) && part.type === "image") {
        parts.push({ type: "text", text: "[image]" });
      }
    }
    return { role: messageRole, content: parts.length > 0 ? parts : "" };
  }

  function assistantParts(message: AssistantMessage): PostHogPart[] {
    const parts: PostHogPart[] = [];
    for (const part of message.content) {
      if (part.type === "text") {
        parts.push({
          type: "text",
          text: boundText(redactText(part.text), TRACE_MESSAGE_CHARS).text,
        });
      } else if (part.type === "thinking") {
        parts.push({
          type: "thinking",
          thinking: boundText(redactText(part.thinking), TRACE_MESSAGE_CHARS).text,
        });
      } else if (part.type === "toolCall") {
        const args = boundTraceValue(
          recording.redact(part.arguments),
          TRACE_MESSAGE_CHARS,
          TRACE_TOOL_STATE_CHARS,
        );
        noteFindings(args);
        parts.push({
          type: "function",
          id: part.id,
          function: { name: part.name, arguments: args },
        });
      }
    }
    return parts;
  }

  function turnFromAgentMessage(message: AgentMessage): PostHogMessage {
    switch (message.role) {
      case "system":
      case "user":
        return messageFromUserOrSystem(message.role, message.content);
      case "assistant":
        return { role: "assistant", content: assistantParts(message) };
      case "toolResult":
        return {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: message.toolCallId,
              content: boundText(redactText(contentText(message.content)), TRACE_MESSAGE_CHARS)
                .text,
            },
          ],
        };
      default: {
        const exhaustive: never = message;
        return exhaustive;
      }
    }
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
      ...(status === "error"
        ? {
            isError: true,
            error: errorDetail(
              "provider_error",
              message.errorMessage?.trim() || message.stopReason,
            ),
          }
        : {}),
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
    const now = Date.now();
    const latencyMs = now - current.startedAt;
    modelMs += latencyMs;
    if (output) lastActivity = now;
    const choices = output ? assistantParts(output) : [];
    const streamed =
      choices.length === 0 && resolved !== "ok" && current.streamed
        ? assistantParts(current.streamed)
        : [];
    const partial = streamed.length > 0;
    const shown = partial ? streamed : choices;
    recording.emit({
      event: "$ai_generation",
      spanId: current.id,
      parentId: sessionId,
      spanName: "generation",
      provider: model.provider,
      model: model.id,
      status: resolved,
      latencyMs,
      ...(current.ttftMs != null ? { ttftMs: current.ttftMs } : {}),
      ...(current.reasoningMs != null ? { reasoningMs: current.reasoningMs } : {}),
      ...(resolved === "error"
        ? {
            isError: true,
            error:
              measured?.error ??
              errorDetail(error ?? "interrupted", sessionErrorDetail ?? error ?? "interrupted"),
          }
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
      outputChoices: toPostHogOutputChoices(shown),
      tools: toolDefs,
      extra: {
        ...measured?.extra,
        provider_attempts: getAttempts() - current.attemptStart,
        retry_folded: params.cfg.provider.retryMax > 0,
        checkpoint_id: opts?.checkpointId ?? null,
        turn_index: current.turnIndex,
        ...(partial ? { partial: true } : {}),
        ...(error != null ? { error_code: error } : {}),
      },
    });
    if (output) appendTurn({ role: "assistant", content: shown.length > 0 ? shown : choices });
    else if (partial) appendTurn({ role: "assistant", content: streamed });
  }

  function finishTool(tool: OpenTool, status: TraceStatus, result: unknown, error?: string): void {
    const now = Date.now();
    toolMs += now - tool.startedAt;
    const hostCalls = tool.hostCalls.map((call) =>
      hostCallEntry(call, now, redactText, sha256Hex(safeJson(recording.redact(call.input)))),
    );
    const output = result === undefined ? { status, ...(error != null ? { error } : {}) } : result;
    const body = toolBody(tool.name, status, tool.args, output);
    lastToolBody = body;
    recording.emit({
      event: "$ai_span",
      spanId: tool.id,
      parentId: lastGenerationId ?? sessionId,
      spanName: `tool:${tool.name}`,
      provider: model.provider,
      model: model.id,
      status,
      latencyMs: now - tool.startedAt,
      ...(status === "error"
        ? { isError: true, error: errorDetail("tool_error", error ?? "tool_error") }
        : {}),
      ...identity(tool.phase),
      inputState: body.input,
      outputState: body.output,
      ...(hostCalls.length > 0 ? { hostCalls } : {}),
      extra: {
        ...tool.extra,
        input_sha256: body.input_sha256,
        ...(body.code_sha256 != null ? { code_sha256: body.code_sha256 } : {}),
      },
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
        ? {
            isError: true,
            error: measured?.error ?? errorDetail("compaction_failed", "compaction_failed"),
          }
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
        { role: "system", content: boundText(redactText(current.system), TRACE_SYSTEM_CHARS).text },
        { role: "user", content: boundText(redactText(current.prompt), TRACE_MESSAGE_CHARS).text },
      ],
      ...(message ? { outputChoices: toPostHogOutputChoices(assistantParts(message)) } : {}),
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
      if (event.type === "turn_start") generation = openGeneration();
      if (event.type === "message_start") {
        const message = event.message;
        if (message.role === "user" || message.role === "system") rememberUserOrSystem(message);
        if (message.role === "assistant") generation ??= openGeneration();
      }
      if (event.type === "message_update" && generation) {
        const type = event.assistantMessageEvent.type;
        const now = Date.now();
        lastActivity = now;
        if (event.message.role === "assistant") generation.streamed = event.message;
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
          noteFindings(event.message.content);
          appendTurn(turnFromAgentMessage(event.message));
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
          hostCalls: [],
          extra: {},
        };
        if (isPlainObject(event.args) && Array.isArray(event.args.findings)) {
          tool.extra.findings_count = event.args.findings.length;
        }
        noteFindings(event.args);
        noteCode(event.args);
        tools.set(event.toolCallId, tool);
        toolCalls += 1;
        lastTool = tool.name;
        lastActivity = tool.startedAt;
        const printed = toolCallKey(tool.name, event.args);
        toolCallKeys.set(printed.key, (toolCallKeys.get(printed.key) ?? 0) + 1);
      }
      if (event.type === "tool_execution_end") {
        const tool = tools.get(event.toolCallId);
        if (!tool) return;
        const failure = toolFailure(event.result, event.isError);
        lastActivity = Date.now();
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
    hostCall: (
      toolCallId: string,
      name: string,
      input: unknown,
    ): ((outcome: HostCallOutcome) => void) | undefined => {
      if (disposed) return undefined;
      const tool = tools.get(toolCallId);
      if (!tool) return undefined;
      hostCallCount += 1;
      lastActivity = Date.now();
      const printed = toolCallKey(name, input);
      const seen = hostCallKeys.get(printed.key);
      if (seen) seen.count += 1;
      else hostCallKeys.set(printed.key, { tool: name, hash: printed.hash, count: 1 });
      if (tool.hostCalls.length >= CODE_MODE_MAX_TOOL_CALLS) {
        const omitted = tool.extra.host_calls_omitted;
        tool.extra.host_calls_omitted = (typeof omitted === "number" ? omitted : 0) + 1;
        return undefined;
      }
      const record: HostCallRecord = { tool: name, input, startedAt: Date.now() };
      tool.hostCalls.push(record);
      return (outcome) => {
        if (record.outcome) return;
        record.outcome = outcome;
        record.endedAt = Date.now();
        lastActivity = record.endedAt;
      };
    },
    endSend: (end: string, errorCode?: string, errorDetailText?: string): string | undefined => {
      lastEnd = end;
      if (errorDetailText) sessionErrorDetail = errorDetailText;
      const status: TraceStatus | undefined = errorCode
        ? errorCode === "agent.session_aborted"
          ? "cancelled"
          : "error"
        : undefined;
      if (generation) closeGeneration(status ?? "error", errorCode ?? "interrupted");
      if (errorCode && status) {
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
      for (const message of messages) basis.push(turnFromAgentMessage(message));
    },
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      if (generation) closeGeneration("cancelled");
      if (compaction) finishCompaction(undefined, "cancelled");
      for (const tool of tools.values()) finishTool(tool, "cancelled", undefined);
      tools.clear();
      const now = Date.now();
      const failed = sessionStatus !== "ok";
      recording.emit({
        event: "$ai_span",
        spanId: sessionId,
        parentId: recording.executionSpanId,
        spanName: "session",
        provider: model.provider,
        model: model.id,
        status: sessionStatus,
        latencyMs: now - startedAt,
        ...(sessionStatus === "error"
          ? {
              isError: true,
              error: errorDetail(
                sessionError ?? "error",
                sessionErrorDetail ?? sessionError ?? "error",
              ),
            }
          : {}),
        ...identity(opts?.phase),
        ...(failed
          ? {
              inputState: {
                last_turns: basis.slice(-TRACE_LAST_TURNS),
                partial_findings: partialFindings,
              },
              outputState: {
                why: {
                  status: sessionStatus,
                  code: sessionError ?? null,
                  message:
                    sessionErrorDetail != null
                      ? errorDetail(sessionError ?? "error", sessionErrorDetail).message
                      : (sessionError ?? null),
                  last_end: lastEnd ?? null,
                },
                ...(lastToolBody != null ? { last_tool: lastToolBody } : {}),
              },
            }
          : {}),
        extra: loopCounters(now),
      });
      recording.closeOwnedExecution();
    },
  };
}

function boundedText(
  text: string,
  limit: number,
  redact: (text: string) => string,
): { readonly text: string; readonly truncated: boolean } {
  const redacted = redact(text);
  if (redacted.length <= limit) return { text: redacted, truncated: false };
  return { text: `${redacted.slice(0, limit)}\n${TRACE_CONTENT_TRUNCATED}`, truncated: true };
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : safeJson(value);
}

function hostCallEntry(
  call: HostCallRecord,
  now: number,
  redact: (text: string) => string,
  inputSha: string,
): Record<string, unknown> {
  const inputText = asText(call.input);
  const input =
    inputText.length <= HOST_CALL_INPUT_CHARS
      ? call.input
      : boundedText(inputText, HOST_CALL_INPUT_CHARS, redact).text;
  const { outcome, endedAt } = call;
  const hash = { input_sha256: inputSha };
  if (!outcome || endedAt == null) {
    return {
      tool: call.tool,
      status: "in_flight",
      input,
      elapsed_ms: now - call.startedAt,
      ...hash,
    };
  }
  const base = { tool: call.tool, input, duration_ms: endedAt - call.startedAt, ...hash };
  if (outcome.status === "error") {
    return { ...base, status: "error", error_kind: outcome.errorKind };
  }
  const preview = boundedText(asText(outcome.output), HOST_CALL_PREVIEW_CHARS, redact);
  return {
    ...base,
    status: "completed",
    output_bytes: outcome.outputBytes,
    output_preview: preview.text,
    ...(preview.truncated ? { preview_truncated: true } : {}),
  };
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
      } catch {}
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
  hostCall: () => undefined,
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
    hostCall: (toolCallId: string, name: string, input: unknown) => {
      const close = observe(() => recording.hostCall(toolCallId, name, input));
      return close ? protect(close) : undefined;
    },
    endSend: protect(recording.endSend),
    beginCompaction: protect(recording.beginCompaction),
    endCompaction: protect(recording.endCompaction),
    compacted: protect(recording.compacted),
    dispose: protect(recording.dispose),
  };
}
