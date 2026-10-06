import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { Config } from "../settings/index.js";
import { SHUTDOWN_SETTLE_TIMEOUT_MS } from "../settings/index.js";
import { createPgPool } from "../db/postgres.js";
import { appendTraceSpans } from "../agentWork/agentTraceRepository.js";
import { appendAgentEvents } from "../agentWork/agentEventsRepository.js";
import { logWarn } from "../evlog.js";
import { createTraceRedactor, tracePart } from "./content.js";
import type { TracePartKind, TraceSpan } from "./traceTypes.js";

const FLUSH_MS = 500;
const BATCH_SPANS = 200;
const BUFFER_BYTES = 8 * 1024 * 1024;
const SPAN_BYTES = 256 * 1024;
const PART_BYTES = 64 * 1024;
type ExecutionTrace = {
  readonly span: TraceSpan;
  dropped: number;
  pending: number;
  sessions: number;
  finished: boolean;
  reported: boolean;
};
const context = new AsyncLocalStorage<ExecutionTrace>();

export class TraceRecorder {
  private readonly redactor;
  private readonly queue: { span: TraceSpan; execution: ExecutionTrace }[] = [];
  private queuedBytes = 0;
  private bufferedSpans = 0;
  private readonly reports: ExecutionTrace[] = [];
  private flushing: Promise<void> | undefined;
  private closed = false;
  private readonly timer;

  constructor(
    private readonly pool: Pool,
    private readonly cfg: Config,
  ) {
    this.redactor = createTraceRedactor(cfg);
    this.timer = setInterval(() => void this.flush(), FLUSH_MS);
    this.timer.unref();
  }

  addSecret(value: string | undefined): void {
    this.redactor.addSecret(value);
  }

  execution(executionId: string, workItemId: string | null): ExecutionTrace {
    const execution: ExecutionTrace = {
      span: this.span({ executionId, workItemId, kind: "execution" }),
      dropped: 0,
      pending: 0,
      sessions: 0,
      finished: false,
      reported: false,
    };
    return execution;
  }

  span(
    input: Pick<TraceSpan, "executionId" | "workItemId" | "kind"> &
      Partial<
        Pick<TraceSpan, "id" | "parentId" | "role" | "phase" | "provider" | "model" | "specialist">
      >,
  ): TraceSpan {
    const now = new Date();
    return {
      ...input,
      id: input.id ?? randomUUID(),
      parentId: input.parentId ?? null,
      role: input.role ?? null,
      phase: input.phase ?? null,
      provider: input.provider ?? null,
      model: input.model ?? null,
      specialist: input.specialist ?? null,
      startedAt: now,
      endedAt: now,
      ttftMs: null,
      reasoningMs: null,
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
      reasoning: null,
      costUsd: null,
      costSource: "unknown",
      status: "ok",
      errorCode: null,
      attrs: {},
      parts: [],
    };
  }

  part(span: TraceSpan, kind: TracePartKind, value: unknown): void {
    if (this.cfg.traces.mode !== "content" || this.closed) return;
    try {
      const used = span.parts.reduce((bytes, part) => bytes + part.bytes, 0);
      if (used >= SPAN_BYTES || span.parts.length >= 128) {
        span.attrs.content_truncated = true;
        return;
      }
      const text = typeof value === "string" ? value : JSON.stringify(value);
      if (text === undefined) return;
      const redacted = this.redactor.redact(text);
      const limit = Math.min(PART_BYTES, SPAN_BYTES - used);
      const bytes = Buffer.from(redacted.body.slice(0, limit));
      const truncated = redacted.body.length > limit || bytes.length > limit;
      const body = truncated
        ? `${bytes.subarray(0, Math.max(0, limit - 32)).toString("utf8")}\n[trace content truncated]`
        : redacted.body;
      if (truncated) span.attrs.content_truncated = true;
      span.parts.push(tracePart(kind, body, redacted.redactions));
    } catch {
      span.attrs.content_error = true;
      logWarn("agent_trace_content_failed");
    }
  }

  finish(span: TraceSpan, execution: ExecutionTrace): void {
    span.endedAt = new Date();
    const bytes = span.parts.reduce((sum, part) => sum + part.bytes, 0) + 2048;
    if (
      this.closed ||
      this.bufferedSpans >= this.cfg.traces.bufferMaxSpans ||
      this.queuedBytes + bytes > BUFFER_BYTES
    ) {
      execution.dropped += 1;
      return;
    }
    execution.pending += 1;
    this.bufferedSpans += 1;
    this.queue.push({ span, execution });
    this.queuedBytes += bytes;
    if (this.queue.length >= BATCH_SPANS) void this.flush();
  }

  finishExecution(execution: ExecutionTrace): void {
    this.finish(execution.span, execution);
    execution.finished = true;
    this.queueDropReport(execution);
  }

  openSession(execution: ExecutionTrace): void {
    execution.sessions += 1;
  }

  closeSession(execution: ExecutionTrace): void {
    execution.sessions -= 1;
    this.queueDropReport(execution);
  }

  private queueDropReport(execution: ExecutionTrace): void {
    if (!execution.finished || execution.pending || execution.sessions || execution.reported)
      return;
    execution.reported = true;
    if (!execution.dropped) return;
    if (this.reports.length >= this.cfg.traces.bufferMaxSpans) {
      logWarn("agent_trace_drop_report_overflow", { count: execution.dropped });
    } else {
      this.reports.push(execution);
    }
  }

  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushBatch().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  private async flushBatch(): Promise<void> {
    const batch = this.queue.splice(0, BATCH_SPANS);
    try {
      await appendTraceSpans(
        this.pool,
        batch.map((entry) => entry.span),
      );
    } catch {
      for (const entry of batch) entry.execution.dropped += 1;
      logWarn("agent_trace_flush_failed", { count: batch.length });
    } finally {
      const executions = new Set(batch.map((entry) => entry.execution));
      for (const entry of batch) entry.execution.pending -= 1;
      this.bufferedSpans -= batch.length;
      this.queuedBytes -= batch.reduce(
        (sum, entry) =>
          sum + 2048 + entry.span.parts.reduce((bytes, part) => bytes + part.bytes, 0),
        0,
      );
      for (const execution of executions) {
        this.queueDropReport(execution);
      }
    }
    const reports = this.reports.splice(0, BATCH_SPANS);
    try {
      await appendAgentEvents(
        this.pool,
        reports.map((execution) => ({
          workItemId: execution.span.workItemId,
          eventKind: "trace_spans_dropped",
          detail: { executionId: execution.span.executionId, count: execution.dropped },
        })),
      );
    } catch {
      logWarn("agent_trace_drop_report_failed", { count: reports.length });
    }
  }

  async drain(): Promise<void> {
    clearInterval(this.timer);
    this.closed = true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          await this.flushing;
          while (this.queue.length > 0 || this.reports.length > 0) await this.flush();
          await this.pool.end();
        })(),
        new Promise<void>((resolve) => {
          timeout = setTimeout(() => {
            logWarn("agent_trace_shutdown_incomplete", { queued: this.queue.length });
            resolve();
          }, SHUTDOWN_SETTLE_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

let recorder: TraceRecorder | undefined;

export function observeTrace<T>(observe: () => T): T | undefined {
  try {
    return observe();
  } catch {
    logWarn("agent_trace_observer_failed");
    return undefined;
  }
}

export function initTraces(cfg: Config): void {
  if (cfg.runtime.role !== "worker" || cfg.traces.mode === "off" || recorder) return;
  try {
    recorder = new TraceRecorder(createPgPool(cfg, 2), cfg);
  } catch {
    logWarn("agent_trace_init_failed");
  }
}

export function currentTrace(): { recorder: TraceRecorder; execution: ExecutionTrace } | undefined {
  const execution = context.getStore();
  return recorder && execution ? { recorder, execution } : undefined;
}

export function sessionTraceContext(workItemId?: string) {
  const current = currentTrace();
  if (current || !recorder) return current;
  return {
    recorder,
    execution: recorder.execution(randomUUID(), workItemId ?? null),
    standalone: true,
  };
}

export async function startWorkTrace<T>(
  executionId: string,
  workItemId: string,
  run: () => Promise<T>,
): Promise<T> {
  if (!recorder) return run();
  const active = recorder;
  const execution = observeTrace(() => active.execution(executionId, workItemId));
  if (!execution) return run();
  return context.run(execution, async () => {
    try {
      return await run();
    } catch (error) {
      execution.span.status = "error";
      execution.span.errorCode = "execution_failed";
      throw error;
    } finally {
      observeTrace(() => active.finishExecution(execution));
    }
  });
}

export async function drainTraces(): Promise<void> {
  const active = recorder;
  recorder = undefined;
  await active?.drain().catch(() => logWarn("agent_trace_drain_failed"));
}
