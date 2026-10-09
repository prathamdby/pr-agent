import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { createPostHogAiCapture, type AiCapture } from "../analytics/posthogSink.js";
import { logWarn } from "../evlog.js";
import { type Config, SHUTDOWN_SETTLE_TIMEOUT_MS } from "../settings/index.js";
import { isPlainObject } from "../util/typeGuards.js";
import { createTraceRedactor, redactTraceValue } from "./content.js";

export const TRACE_EVENT_BYTES = 1024 * 1024;
const MAX_QUEUED = 400;
const MAX_QUEUED_BYTES = 8 * 1024 * 1024;
const FLUSH_MS = 500;
const MARKER = "[trace content truncated]";

export type TraceStatus = "ok" | "error" | "cancelled";

export type TraceDraft = {
  readonly event: "$ai_generation" | "$ai_span";
  readonly spanId: string;
  readonly parentId: string | null;
  readonly spanName: string;
  readonly provider: string;
  readonly model: string;
  readonly status: TraceStatus;
  readonly latencyMs: number;
  readonly ttftMs?: number;
  readonly reasoningMs?: number;
  readonly isError?: boolean;
  readonly error?: string;
  readonly phase?: string;
  readonly role?: string;
  readonly specialist?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly cacheWrite1hTokens?: number;
  readonly totalTokens?: number;
  readonly costUsd?: number;
  readonly input?: unknown;
  readonly outputChoices?: unknown;
  readonly tools?: unknown;
  readonly inputState?: unknown;
  readonly outputState?: unknown;
  readonly extra?: Readonly<Record<string, string | number | boolean | null>>;
};

export type TraceWork = {
  readonly executionId: string;
  readonly workItemId: string;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly installationId: number;
  readonly provider: string;
  readonly model: string;
};

type ExecutionState = {
  readonly executionId: string;
  readonly executionSpanId: string;
  readonly workItemId: string | null;
  readonly owner?: string;
  readonly repo?: string;
  readonly prNumber?: number;
  readonly headSha?: string;
  readonly installationId?: number;
  readonly provider: string;
  readonly model: string;
  readonly startedAt: number;
  status: TraceStatus;
  errorCode: string | null;
};

type QueuedEvent = {
  readonly event: string;
  readonly distinctId: string;
  readonly properties: Record<string, unknown>;
  readonly bytes: number;
};

const context = new AsyncLocalStorage<ExecutionState>();

class TraceRecorder {
  private readonly redactor;
  private readonly queue: QueuedEvent[] = [];
  private queuedBytes = 0;
  private flushing: Promise<void> | undefined;
  private closed = false;
  private readonly timer;

  constructor(
    private readonly cfg: Config,
    private readonly capture: AiCapture,
  ) {
    this.redactor = createTraceRedactor(cfg);
    this.timer = setInterval(() => void this.flush(), FLUSH_MS);
    this.timer.unref();
  }

  addSecret(value: string | undefined): void {
    this.redactor.addSecret(value);
  }

  redact(value: unknown): unknown {
    return redactTraceValue(value, (text) => this.redactor.redact(text));
  }

  emit(execution: ExecutionState, draft: TraceDraft): void {
    if (this.closed) return;
    try {
      const properties = fitProperties(
        propertiesFor(execution, draft, (value) => this.redact(value)),
      );
      if (!properties) {
        logWarn("agent_trace_event_dropped", { kind: draft.spanName, bytes: TRACE_EVENT_BYTES });
        return;
      }
      const bytes = eventBytes(properties);
      if (this.queue.length >= MAX_QUEUED || this.queuedBytes + bytes > MAX_QUEUED_BYTES) {
        logWarn("agent_trace_span_dropped", { bytes });
        return;
      }
      this.queue.push({
        event: draft.event,
        distinctId: distinctId(execution),
        properties,
        bytes,
      });
      this.queuedBytes += bytes;
    } catch {
      logWarn("agent_trace_observer_failed");
    }
  }

  async flush(): Promise<void> {
    if (this.flushing) {
      await this.flushing;
      if (this.queue.length === 0) return;
    }
    const run = this.flushBatch();
    this.flushing = run;
    try {
      await run;
    } finally {
      if (this.flushing === run) this.flushing = undefined;
    }
  }

  private async flushBatch(): Promise<void> {
    const batch = this.queue.splice(0, this.queue.length);
    if (batch.length === 0) return;
    const bytes = batch.reduce((sum, entry) => sum + entry.bytes, 0);
    try {
      for (const entry of batch) {
        this.capture.capture({
          distinctId: entry.distinctId,
          event: entry.event,
          properties: entry.properties,
        });
      }
      await this.capture.flush();
    } catch {
      logWarn("agent_trace_send_failed", { count: batch.length });
    } finally {
      this.queuedBytes -= bytes;
    }
  }

  async drain(): Promise<void> {
    clearInterval(this.timer);
    this.closed = true;
    const deadline = Date.now() + SHUTDOWN_SETTLE_TIMEOUT_MS;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          await this.flushing;
          while (this.queue.length > 0) await this.flush();
          const remaining = Math.max(0, deadline - Date.now());
          await this.capture.shutdown(remaining);
        })(),
        new Promise<void>((resolve) => {
          timeout = setTimeout(
            () => {
              logWarn("agent_trace_shutdown_incomplete", { queued: this.queue.length });
              resolve();
            },
            Math.max(0, deadline - Date.now()),
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

let recorder: TraceRecorder | undefined;

export function initTraces(cfg: Config, capture?: AiCapture): () => Promise<void> {
  if (cfg.runtime.role !== "worker") return async () => undefined;
  const token = cfg.posthog.projectToken.trim();
  if (!capture && token.length === 0) return async () => undefined;
  const previous = recorder;
  recorder = undefined;
  let active: TraceRecorder | undefined;
  try {
    active = new TraceRecorder(
      cfg,
      capture ?? createPostHogAiCapture({ projectToken: token, host: cfg.posthog.host }),
    );
    recorder = active;
  } catch {
    logWarn("agent_trace_init_failed");
  }
  if (previous) void previous.drain().catch(() => logWarn("agent_trace_drain_failed"));
  return async () => {
    if (recorder === active) recorder = undefined;
    await active?.drain().catch(() => logWarn("agent_trace_drain_failed"));
  };
}

export type TraceHandle = {
  readonly executionId: string;
  readonly workItemId: string | null;
  readonly executionSpanId: string;
  readonly provider: string;
  readonly model: string;
  addSecret(value: string | undefined): void;
  redact(value: unknown): unknown;
  emit(draft: TraceDraft): void;
  fail(status: Exclude<TraceStatus, "ok">, errorCode: string): void;
  closeOwnedExecution(): void;
};

export function openTraceSession(input: {
  readonly provider: string;
  readonly model: string;
}): TraceHandle | undefined {
  const active = recorder;
  if (!active) return undefined;
  const current = context.getStore();
  const execution =
    current ??
    executionState({
      executionId: randomUUID(),
      workItemId: null,
      provider: input.provider,
      model: input.model,
    });
  const owned = current == null;
  return handle(active, execution, input.provider, input.model, owned);
}

export function recordExecutionSpan(
  draft: Omit<TraceDraft, "provider" | "model" | "parentId">,
): void {
  const active = recorder;
  const execution = context.getStore();
  if (!active || !execution) return;
  active.emit(execution, {
    ...draft,
    provider: execution.provider,
    model: execution.model,
    parentId: execution.executionSpanId,
  });
}

export async function startWorkTrace<T>(work: TraceWork, run: () => Promise<T>): Promise<T> {
  const active = recorder;
  if (!active) return run();
  const execution = executionState({
    executionId: work.executionId,
    workItemId: work.workItemId,
    owner: work.owner,
    repo: work.repo,
    prNumber: work.prNumber,
    headSha: work.headSha,
    installationId: work.installationId,
    provider: work.provider,
    model: work.model,
  });
  try {
    return await context.run(execution, run);
  } catch (error) {
    if (execution.status === "ok") {
      execution.status = "error";
      execution.errorCode = "execution_failed";
    }
    throw error;
  } finally {
    active.emit(execution, executionDraft(execution));
  }
}

function handle(
  active: TraceRecorder,
  execution: ExecutionState,
  provider: string,
  model: string,
  owned: boolean,
): TraceHandle {
  return {
    executionId: execution.executionId,
    workItemId: execution.workItemId,
    executionSpanId: execution.executionSpanId,
    provider,
    model,
    addSecret(value) {
      active.addSecret(value);
    },
    redact(value) {
      return active.redact(value);
    },
    emit(draft) {
      active.emit(execution, draft);
    },
    fail(status, errorCode) {
      if (execution.status === "ok") {
        execution.status = status;
        execution.errorCode = errorCode;
      }
    },
    closeOwnedExecution() {
      if (!owned) return;
      active.emit(execution, executionDraft(execution));
    },
  };
}

function executionState(input: {
  readonly executionId: string;
  readonly workItemId: string | null;
  readonly owner?: string;
  readonly repo?: string;
  readonly prNumber?: number;
  readonly headSha?: string;
  readonly installationId?: number;
  readonly provider: string;
  readonly model: string;
}): ExecutionState {
  return {
    ...input,
    executionSpanId: randomUUID(),
    startedAt: Date.now(),
    status: "ok",
    errorCode: null,
  };
}

function executionDraft(execution: ExecutionState): TraceDraft {
  return {
    event: "$ai_span",
    spanId: execution.executionSpanId,
    parentId: null,
    spanName: "execution",
    provider: execution.provider,
    model: execution.model,
    status: execution.status,
    latencyMs: Date.now() - execution.startedAt,
    ...(execution.status === "error"
      ? { isError: true, error: execution.errorCode ?? "error" }
      : {}),
  };
}

function distinctId(execution: ExecutionState): string {
  return execution.installationId != null ? `installation:${execution.installationId}` : "pr-agent";
}

function propertiesFor(
  execution: ExecutionState,
  draft: TraceDraft,
  redact: (value: unknown) => unknown,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    $ai_trace_id: execution.executionId,
    $ai_session_id: execution.workItemId,
    $ai_span_id: draft.spanId,
    $ai_span_name: draft.spanName,
    $ai_provider: draft.provider,
    $ai_model: draft.model,
    $ai_latency: draft.latencyMs / 1000,
    $process_person_profile: false,
    status: draft.status,
  };
  if (draft.parentId != null) properties.$ai_parent_id = draft.parentId;
  if (draft.ttftMs != null) properties.$ai_time_to_first_token = draft.ttftMs / 1000;
  if (draft.reasoningMs != null) properties.reasoning_seconds = draft.reasoningMs / 1000;
  if (draft.isError) properties.$ai_is_error = true;
  if (draft.error != null) properties.$ai_error = redact(draft.error);
  if (draft.phase != null) properties.phase = draft.phase;
  if (draft.role != null) properties.session_role = draft.role;
  if (draft.specialist != null) properties.specialist_id = draft.specialist;
  assignCount(properties, "$ai_input_tokens", draft.inputTokens);
  assignCount(properties, "$ai_output_tokens", draft.outputTokens);
  assignCount(properties, "$ai_cache_read_tokens", draft.cacheReadTokens);
  assignCount(properties, "$ai_cache_write_tokens", draft.cacheWriteTokens);
  assignCount(properties, "$ai_cache_write_1h_tokens", draft.cacheWrite1hTokens);
  assignCount(properties, "$ai_total_tokens", draft.totalTokens);
  if (draft.costUsd != null && draft.costUsd > 0) properties.$ai_total_cost_usd = draft.costUsd;
  if (execution.owner != null) properties.owner = execution.owner;
  if (execution.repo != null) properties.repo = execution.repo;
  if (execution.prNumber != null) properties.pr_number = execution.prNumber;
  if (execution.headSha != null) properties.head_sha = execution.headSha;
  if (draft.input !== undefined) properties.$ai_input = redact(draft.input);
  if (draft.outputChoices !== undefined)
    properties.$ai_output_choices = redact(draft.outputChoices);
  if (draft.tools !== undefined) properties.$ai_tools = redact(draft.tools);
  if (draft.inputState !== undefined) properties.$ai_input_state = redact(draft.inputState);
  if (draft.outputState !== undefined) properties.$ai_output_state = redact(draft.outputState);
  const extra = draft.extra == null ? undefined : redact(draft.extra);
  if (isPlainObject(extra)) Object.assign(properties, extra);
  return properties;
}

function assignCount(
  properties: Record<string, unknown>,
  key: string,
  value: number | undefined,
): void {
  if (value != null) properties[key] = value;
}

function eventBytes(properties: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(properties));
}

function fitProperties(properties: Record<string, unknown>): Record<string, unknown> | undefined {
  if (eventBytes(properties) <= TRACE_EVENT_BYTES) return properties;
  let next = properties;
  if (next.$ai_input !== undefined) {
    next = { ...next, $ai_input: elideInput(next.$ai_input) };
    if (eventBytes(next) <= TRACE_EVENT_BYTES) return next;
    next = { ...next, $ai_input: [{ role: "user", content: MARKER }] };
    if (eventBytes(next) <= TRACE_EVENT_BYTES) return next;
  }
  if (next.$ai_tools !== undefined) {
    next = { ...next, $ai_tools: MARKER };
    if (eventBytes(next) <= TRACE_EVENT_BYTES) return next;
  }
  for (const key of ["$ai_input_state", "$ai_output_state"] as const) {
    if (next[key] !== undefined) {
      next = { ...next, [key]: MARKER };
      if (eventBytes(next) <= TRACE_EVENT_BYTES) return next;
    }
  }
  if (next.$ai_output_choices !== undefined) {
    next = { ...next, $ai_output_choices: truncateChoices(next.$ai_output_choices) };
    if (eventBytes(next) <= TRACE_EVENT_BYTES) return next;
  }
  return undefined;
}

function elideInput(input: unknown): unknown {
  if (!Array.isArray(input) || input.length < 3) return markerValue(input);
  const head = input[0];
  const tail = input[input.length - 1];
  return [head, { role: "user", content: MARKER }, tail];
}

function markerValue(value: unknown): unknown {
  if (typeof value === "string") return `${value.slice(0, 1024)}\n${MARKER}`;
  return MARKER;
}

function truncateChoices(value: unknown): unknown {
  if (!Array.isArray(value)) return markerValue(value);
  return value.map((choice) => {
    if (!isPlainObject(choice)) return choice;
    const next: Record<string, unknown> = { ...choice };
    for (const key of ["text", "thinking", "arguments"]) {
      const field = next[key];
      if (typeof field === "string" && field.length > 2048) {
        next[key] = `${field.slice(0, 2048)}\n${MARKER}`;
      }
    }
    return next;
  });
}
