import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestConfig } from "./helpers/config.ts";
import { agentAuditRecordFromLifecycleEvent } from "../src/agent/runtime/agentAudit.ts";
import type { AgentLifecycleEvent } from "../src/agent/runtime/lifecycleEvents.ts";

const analyticsMocks = vi.hoisted(() => ({
  captureEvent: vi.fn(),
  loggedAgentEvents: [] as Array<Record<string, unknown>>,
  recordExecutionSpan: vi.fn(),
}));

vi.mock("../src/traces/recorder.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/traces/recorder.ts")>()),
  recordExecutionSpan: (...args: unknown[]) => analyticsMocks.recordExecutionSpan(...args),
}));

vi.mock("../src/analytics/index.ts", () => ({
  captureEvent: (...args: unknown[]) => analyticsMocks.captureEvent(...args),
  captureException: vi.fn(),
}));

vi.mock("../src/evlog.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/evlog.ts")>();
  return {
    ...actual,
    logInfo: (event: string, data?: Record<string, unknown>) => {
      if (event === "agent_event" && data != null) {
        analyticsMocks.loggedAgentEvents.push(data);
      }
    },
  };
});

import {
  createDurableLifecycleEventSink,
  lifecycleAuditToInsertRow,
  safeEmitPublishEvent,
  type AgentEventsContext,
} from "../src/agent/runtime/agentEventSink.ts";
import {
  llmSpanFromSession,
  projectWorkSpanToAgentEventRow,
  publishSpanFromContext,
} from "../src/analytics/workSpan.ts";

describe("agentAuditRecordFromLifecycleEvent", () => {
  it("derives metadata-only audit records without content fields", () => {
    const record = agentAuditRecordFromLifecycleEvent(
      {
        kind: "failure",
        role: "specialist",
        phase: "specialist",
        checkpointId: "cp-9",
        provider: "openai",
        model: "gpt-4o-mini",
        ok: false,
        failureCode: "provider.rate_limit",
        failureDomain: "provider",
        errorKind: "rate_limit",
      },
      () => new Date("2026-07-23T00:00:00.000Z"),
    );
    expect(record).toEqual({
      source: "agent_lifecycle",
      kind: "failure",
      role: "specialist",
      phase: "specialist",
      checkpointId: "cp-9",
      provider: "openai",
      model: "gpt-4o-mini",
      ok: false,
      failureCode: "provider.rate_limit",
      failureDomain: "provider",
      errorKind: "rate_limit",
      recordedAt: "2026-07-23T00:00:00.000Z",
    });
    expect(JSON.stringify(record)).not.toMatch(/prompt|reasoning|sk-|diff|toolCall/i);
  });
});

const spanContext = {
  workItemId: "wi-span",
  installationId: 7,
  owner: "o",
  repo: "r",
  prNumber: 3,
};

describe("work span projection", () => {
  it("parents LLM spans under the work item and omits missing tokens", () => {
    const span = llmSpanFromSession({
      context: spanContext,
      phase: "recon",
      sessionRole: "orchestrator",
      provider: "openai",
      model: "gpt-4o-mini",
      latencyMs: 1500,
      isError: false,
    });
    expect(span.parentSpanId).toBe("wi-span");
    expect(span.inputTokens).toBeUndefined();
    const row = projectWorkSpanToAgentEventRow(spanContext, span);
    expect(row.detail).not.toHaveProperty("inputTokens");
    expect(row.detail).toMatchObject({ latencyMs: 1500, parentSpanId: "wi-span" });
  });

  it("keeps a null publish parent off the audit detail", () => {
    const span = publishSpanFromContext({
      context: spanContext,
      publishStep: "batch-1",
      latencyMs: 40,
      isError: false,
      parentSpanId: null,
    });
    const row = projectWorkSpanToAgentEventRow(spanContext, span);
    expect(row.detail).not.toHaveProperty("parentSpanId");
  });
});

describe("durable lifecycle span sink", () => {
  const context: AgentEventsContext = {
    ...spanContext,
  };
  const cfg = makeTestConfig({ agentEvents: { enabled: true } });

  beforeEach(() => {
    analyticsMocks.captureEvent.mockClear();
    analyticsMocks.loggedAgentEvents.length = 0;
    analyticsMocks.recordExecutionSpan.mockClear();
  });

  it("does not emit a generation span when duration is missing", () => {
    const sink = createDurableLifecycleEventSink(context, cfg);
    sink({
      kind: "completion",
      role: "orchestrator",
      phase: "recon",
      provider: "openai",
      model: "gpt-4o-mini",
      ok: true,
    });
    expect(analyticsMocks.captureEvent).not.toHaveBeenCalled();
  });

  it("emits a generation span with measured latency and parent id", () => {
    const sink = createDurableLifecycleEventSink(context, cfg);
    sink({
      kind: "completion",
      role: "orchestrator",
      phase: "recon",
      provider: "openai",
      model: "gpt-4o-mini",
      ok: true,
      end: "tool_budget",
      durationMs: 800,
      inputTokens: 12,
      outputTokens: 4,
    });
    expect(analyticsMocks.loggedAgentEvents[0]).toEqual(
      expect.objectContaining({
        eventKind: "completion",
        detail: expect.objectContaining({ end: "tool_budget" }),
      }),
    );
    expect(analyticsMocks.captureEvent).not.toHaveBeenCalled();
    expect(analyticsMocks.recordExecutionSpan).not.toHaveBeenCalled();
  });

  it("writes the same publish span id to structured logs and PostHog", () => {
    safeEmitPublishEvent(context, cfg, {
      specialist: "correctness",
      batchId: "batch-9",
      postedCount: 2,
      latencyMs: 250,
    });
    const draft = analyticsMocks.recordExecutionSpan.mock.calls[0]?.[0] as {
      spanId: string;
      event: string;
      latencyMs: number;
      extra: { publish_step: string };
    };
    expect(draft.event).toBe("$ai_span");
    expect(draft.latencyMs).toBe(250);
    expect(draft.extra.publish_step).toBe("batch-9");
    expect(analyticsMocks.captureEvent).not.toHaveBeenCalled();
    const row = analyticsMocks.loggedAgentEvents[0] as
      | {
          eventKind: string;
          detail: { spanId: string; parentSpanId: string; latencyMs: number };
        }
      | undefined;
    expect(row?.eventKind).toBe("publish");
    expect(row?.detail.spanId).toBe(draft.spanId);
    expect(row?.detail.parentSpanId).toBe("wi-span");
    expect(row?.detail.latencyMs).toBe(250);
  });
});

describe("cache token telemetry round-trip", () => {
  beforeEach(() => {
    analyticsMocks.captureEvent.mockClear();
    analyticsMocks.loggedAgentEvents.length = 0;
    analyticsMocks.recordExecutionSpan.mockClear();
  });
  const cacheTokens = {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 800,
    cacheWriteTokens: 50,
    cacheWrite1hTokens: 10,
    totalTokens: 980,
  };

  it("keeps cache fields on usage events and audit records", () => {
    const event: AgentLifecycleEvent = {
      kind: "usage",
      role: "orchestrator",
      phase: "recon",
      provider: "openai",
      model: "gpt-4o-mini",
      ...cacheTokens,
    };
    expect(event.kind === "usage" ? agentAuditRecordFromLifecycleEvent(event) : null).toEqual(
      expect.objectContaining(cacheTokens),
    );
    const completion: AgentLifecycleEvent = {
      kind: "completion",
      role: "orchestrator",
      phase: "recon",
      checkpointId: "orchestrator:recon",
      provider: "openai",
      model: "gpt-4o-mini",
      ok: true,
      end: "completed",
      durationMs: 1200,
      ...cacheTokens,
    };
    expect(
      completion.kind === "completion" ? agentAuditRecordFromLifecycleEvent(completion) : null,
    ).toEqual(expect.objectContaining(cacheTokens));
  });

  it("carries cache fields from audit rows into agent_events.detail", () => {
    const completion: AgentLifecycleEvent = {
      kind: "completion",
      role: "orchestrator",
      phase: "recon",
      checkpointId: "orchestrator:recon",
      provider: "openai",
      model: "gpt-4o-mini",
      ok: true,
      end: "completed",
      durationMs: 1200,
      ...cacheTokens,
    };
    if (completion.kind !== "completion") throw new Error("expected a completion event");
    const record = agentAuditRecordFromLifecycleEvent(completion);
    const rowContext: AgentEventsContext = {
      ...spanContext,
    };
    const row = lifecycleAuditToInsertRow(rowContext, record, completion.role);
    expect(row.detail).toEqual(expect.objectContaining(cacheTokens));
  });

  it("projects cache fields to matching structured log rows and PostHog props", () => {
    const span = llmSpanFromSession({
      context: spanContext,
      phase: "recon",
      sessionRole: "orchestrator",
      provider: "openai",
      model: "gpt-4o-mini",
      latencyMs: 1500,
      isError: false,
      ...cacheTokens,
    });
    const row = projectWorkSpanToAgentEventRow(spanContext, span);
    expect(row.detail).toEqual(expect.objectContaining(cacheTokens));
  });

  it("emits cache fields through the durable sink without PostHog double-emit", () => {
    const sinkContext: AgentEventsContext = {
      ...spanContext,
    };
    const sink = createDurableLifecycleEventSink(
      sinkContext,
      makeTestConfig({ agentEvents: { enabled: true } }),
    );
    const completion: AgentLifecycleEvent = {
      kind: "completion",
      role: "orchestrator",
      phase: "recon",
      checkpointId: "orchestrator:recon",
      provider: "openai",
      model: "gpt-4o-mini",
      ok: true,
      end: "completed",
      durationMs: 1200,
      ...cacheTokens,
    };
    sink(completion);
    expect(analyticsMocks.loggedAgentEvents).toHaveLength(2);
    expect(analyticsMocks.loggedAgentEvents[0]).toEqual(
      expect.objectContaining({
        eventKind: "completion",
        detail: expect.objectContaining(cacheTokens),
      }),
    );
    expect(analyticsMocks.loggedAgentEvents[1]).toEqual(
      expect.objectContaining({
        eventKind: "generation",
        detail: expect.objectContaining(cacheTokens),
      }),
    );
    expect(analyticsMocks.captureEvent).not.toHaveBeenCalled();
    expect(analyticsMocks.recordExecutionSpan).not.toHaveBeenCalled();
  });
});
