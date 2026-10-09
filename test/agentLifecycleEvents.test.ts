import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestConfig } from "./helpers/config.js";
import { agentAuditRecordFromLifecycleEvent } from "../src/agent/runtime/agentAudit.js";
import { sanitizeAgentLifecycleEvent } from "../src/agent/runtime/lifecycleSanitizer.js";

const analyticsMocks = vi.hoisted(() => ({
  captureEvent: vi.fn(),
  appendAgentEvents: vi.fn(async (..._args: unknown[]) => undefined),
  recordExecutionSpan: vi.fn(),
}));

vi.mock("../src/traces/recorder.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/traces/recorder.js")>()),
  recordExecutionSpan: (...args: unknown[]) => analyticsMocks.recordExecutionSpan(...args),
}));

vi.mock("../src/analytics/index.js", () => ({
  captureEvent: (...args: unknown[]) => analyticsMocks.captureEvent(...args),
  captureException: vi.fn(),
}));

vi.mock("../src/agentWork/agentEventsRepository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agentWork/agentEventsRepository.js")>();
  return {
    ...actual,
    appendAgentEvents: analyticsMocks.appendAgentEvents,
    safeAppendAgentEvents: (
      client: unknown,
      cfg: { agentEvents: { enabled: boolean } },
      rows: unknown[],
    ) => {
      if (!cfg.agentEvents.enabled || rows.length === 0) return;
      void analyticsMocks.appendAgentEvents(client, rows);
    },
  };
});

import {
  createDurableLifecycleEventSink,
  lifecycleAuditToInsertRow,
  safeEmitPublishEvent,
  type AgentEventsContext,
} from "../src/agent/runtime/agentEventSink.js";
import {
  llmSpanFromSession,
  projectWorkSpanToAgentEventRow,
  publishSpanFromContext,
} from "../src/analytics/workSpan.js";

describe("sanitizeAgentLifecycleEvent", () => {
  it("allows allowlisted turn fields", () => {
    const event = sanitizeAgentLifecycleEvent({
      kind: "turn",
      role: "orchestrator",
      phase: "recon",
      checkpointId: "cp-1",
      provider: "openai",
      model: "gpt-4o-mini",
    });
    expect(event).toEqual({
      kind: "turn",
      role: "orchestrator",
      phase: "recon",
      checkpointId: "cp-1",
      provider: "openai",
      model: "gpt-4o-mini",
    });
  });

  it("rejects prompts, model text, tool payloads, and credentials", () => {
    expect(
      sanitizeAgentLifecycleEvent({
        kind: "turn",
        role: "ask",
        phase: "ask",
        checkpointId: "cp",
        provider: "openai",
        model: "gpt-4o-mini",
        prompt: "secret user prompt",
      }),
    ).toBeNull();

    expect(
      sanitizeAgentLifecycleEvent({
        kind: "completion",
        role: "ask",
        provider: "openai",
        model: "gpt-4o-mini",
        text: "model answer",
        ok: true,
      }),
    ).toBeNull();

    expect(
      sanitizeAgentLifecycleEvent({
        kind: "tool",
        role: "specialist",
        toolName: "readFile",
        provider: "openai",
        model: "gpt-4o-mini",
        arguments: { path: "src/secret.ts" },
      }),
    ).toBeNull();

    expect(
      sanitizeAgentLifecycleEvent({
        kind: "failure",
        role: "ask",
        provider: "openai",
        model: "gpt-4o-mini",
        failureCode: "provider.auth",
        token: "sk-live",
        ok: false,
      }),
    ).toBeNull();
  });

  it("rejects Date, Map, and custom class instances", () => {
    class LifecycleLike {
      kind = "turn";
      role = "orchestrator";
      phase = "recon";
      checkpointId = "cp-1";
      provider = "openai";
      model = "gpt-4o-mini";
    }
    expect(sanitizeAgentLifecycleEvent(new Date("2026-08-18T00:00:00.000Z"))).toBeNull();
    expect(sanitizeAgentLifecycleEvent(new Map())).toBeNull();
    expect(sanitizeAgentLifecycleEvent(new LifecycleLike())).toBeNull();
  });

  it("accepts a null-prototype record with allowlisted fields", () => {
    const event = Object.assign(Object.create(null), {
      kind: "turn",
      role: "orchestrator",
      phase: "recon",
      checkpointId: "cp-1",
      provider: "openai",
      model: "gpt-4o-mini",
    });
    expect(sanitizeAgentLifecycleEvent(event)).toEqual({
      kind: "turn",
      role: "orchestrator",
      phase: "recon",
      checkpointId: "cp-1",
      provider: "openai",
      model: "gpt-4o-mini",
    });
  });

  it("rejects free-form exception messages as failure codes", () => {
    expect(
      sanitizeAgentLifecycleEvent({
        kind: "failure",
        role: "ask",
        provider: "openai",
        model: "gpt-4o-mini",
        failureCode: "ENOENT: no such file /repo/src/auth.ts",
        ok: false,
      }),
    ).toBeNull();
  });

  it("keeps token counts on completion and still rejects credential token keys", () => {
    expect(
      sanitizeAgentLifecycleEvent({
        kind: "completion",
        role: "orchestrator",
        phase: "recon",
        checkpointId: "orchestrator:recon",
        provider: "openai",
        model: "gpt-4o-mini",
        ok: true,
        end: "output_limit",
        durationMs: 1200,
        inputTokens: 40,
        outputTokens: 12,
      }),
    ).toEqual({
      kind: "completion",
      role: "orchestrator",
      phase: "recon",
      checkpointId: "orchestrator:recon",
      provider: "openai",
      model: "gpt-4o-mini",
      ok: true,
      end: "output_limit",
      durationMs: 1200,
      inputTokens: 40,
      outputTokens: 12,
    });
    expect(
      sanitizeAgentLifecycleEvent({
        kind: "failure",
        role: "ask",
        provider: "openai",
        model: "gpt-4o-mini",
        failureCode: "provider.auth",
        token: "sk-live",
        ok: false,
      }),
    ).toBeNull();
  });

  it("ignores inherited allowlist names without leaking them and still rejects credentials", () => {
    const valid = {
      kind: "completion",
      role: "orchestrator",
      phase: "recon",
      checkpointId: "orchestrator:recon",
      provider: "openai",
      model: "gpt-4o-mini",
      ok: true,
      end: "output_limit",
      durationMs: 1200,
      inputTokens: 40,
      outputTokens: 12,
    };
    for (const key of ["toString", "constructor", "__proto__"] as const) {
      const raw: Record<string, unknown> = { ...valid, [key]: "smuggled" };
      expect(Object.hasOwn(raw, key)).toBe(true);
      expect(sanitizeAgentLifecycleEvent(raw)).toEqual(valid);
    }
    expect(sanitizeAgentLifecycleEvent({ ...valid, token: "sk-live" })).toBeNull();
  });
});

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

  it("allows sanitized execution outcome events without source or arguments", () => {
    const event = sanitizeAgentLifecycleEvent({
      kind: "execution",
      role: "ask",
      provider: "openai",
      model: "gpt-4o-mini",
      outcome: "execution_failure",
      errorCode: "syntax_error",
      durationMs: 12,
      admittedHostCalls: 0,
      completedHostCalls: 0,
      transferredBytes: 0,
      outputBytes: 8,
      terminationReason: "syntax_error",
    });
    expect(event).toEqual({
      kind: "execution",
      role: "ask",
      provider: "openai",
      model: "gpt-4o-mini",
      outcome: "execution_failure",
      errorCode: "syntax_error",
      durationMs: 12,
      admittedHostCalls: 0,
      completedHostCalls: 0,
      transferredBytes: 0,
      outputBytes: 8,
      terminationReason: "syntax_error",
    });
    expect(
      sanitizeAgentLifecycleEvent({
        kind: "execution",
        role: "ask",
        provider: "openai",
        model: "gpt-4o-mini",
        outcome: "success",
        durationMs: 1,
        admittedHostCalls: 0,
        completedHostCalls: 0,
        transferredBytes: 0,
        outputBytes: 0,
        terminationReason: "success",
        arguments: { code: "secret" },
      }),
    ).toBeNull();
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
    pool: {} as AgentEventsContext["pool"],
    ...spanContext,
  };
  const cfg = makeTestConfig({ agentEvents: { enabled: true } });

  beforeEach(() => {
    analyticsMocks.captureEvent.mockClear();
    analyticsMocks.appendAgentEvents.mockClear();
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
    expect(analyticsMocks.appendAgentEvents).toHaveBeenCalledWith(expect.anything(), [
      expect.objectContaining({
        eventKind: "completion",
        detail: expect.objectContaining({ end: "tool_budget" }),
      }),
    ]);
    expect(analyticsMocks.captureEvent).not.toHaveBeenCalled();
    expect(analyticsMocks.recordExecutionSpan).not.toHaveBeenCalled();
  });

  it("writes the same publish span id to Postgres and PostHog", () => {
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
    const rows = analyticsMocks.appendAgentEvents.mock.calls[0]?.[1] as
      | Array<{
          eventKind: string;
          detail: { spanId: string; parentSpanId: string; latencyMs: number };
        }>
      | undefined;
    expect(rows?.[0]?.eventKind).toBe("publish");
    expect(rows?.[0]?.detail.spanId).toBe(draft.spanId);
    expect(rows?.[0]?.detail.parentSpanId).toBe("wi-span");
    expect(rows?.[0]?.detail.latencyMs).toBe(250);
  });
});

describe("cache token telemetry round-trip", () => {
  beforeEach(() => {
    analyticsMocks.captureEvent.mockClear();
    analyticsMocks.appendAgentEvents.mockClear();
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

  it("keeps cache fields on completion and failure events while rejecting credential keys", () => {
    expect(
      sanitizeAgentLifecycleEvent({
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
      }),
    ).toEqual(
      expect.objectContaining({
        kind: "completion",
        ...cacheTokens,
      }),
    );
    expect(
      sanitizeAgentLifecycleEvent({
        kind: "failure",
        role: "specialist",
        phase: "specialist",
        checkpointId: "cp-cache",
        provider: "openai",
        model: "gpt-4o-mini",
        ok: false,
        failureCode: "provider.timeout",
        durationMs: 900,
        ...cacheTokens,
      }),
    ).toEqual(
      expect.objectContaining({
        kind: "failure",
        ...cacheTokens,
      }),
    );
    expect(
      sanitizeAgentLifecycleEvent({
        kind: "completion",
        role: "orchestrator",
        phase: "recon",
        checkpointId: "orchestrator:recon",
        provider: "openai",
        model: "gpt-4o-mini",
        ok: true,
        durationMs: 1200,
        ...cacheTokens,
        apiKey: "sk-live",
      }),
    ).toBeNull();
  });

  it("keeps cache fields on usage events and audit records", () => {
    const event = sanitizeAgentLifecycleEvent({
      kind: "usage",
      role: "orchestrator",
      phase: "recon",
      provider: "openai",
      model: "gpt-4o-mini",
      ...cacheTokens,
    });
    expect(event).toEqual(
      expect.objectContaining({
        kind: "usage",
        ...cacheTokens,
      }),
    );
    expect(event?.kind === "usage" ? agentAuditRecordFromLifecycleEvent(event) : null).toEqual(
      expect.objectContaining(cacheTokens),
    );
    const completion = sanitizeAgentLifecycleEvent({
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
    });
    expect(
      completion?.kind === "completion" ? agentAuditRecordFromLifecycleEvent(completion) : null,
    ).toEqual(expect.objectContaining(cacheTokens));
  });

  it("carries cache fields from audit rows into agent_events.detail", () => {
    const completion = sanitizeAgentLifecycleEvent({
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
    });
    if (completion?.kind !== "completion") throw new Error("expected a completion event");
    const record = agentAuditRecordFromLifecycleEvent(completion);
    const rowContext: AgentEventsContext = {
      pool: {} as AgentEventsContext["pool"],
      ...spanContext,
    };
    const row = lifecycleAuditToInsertRow(rowContext, record, completion.role);
    expect(row.detail).toEqual(expect.objectContaining(cacheTokens));
  });

  it("projects cache fields to matching Postgres rows and PostHog props", () => {
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

  it("emits cache fields through the durable sink to both Postgres and PostHog", () => {
    const sinkContext: AgentEventsContext = {
      pool: {} as AgentEventsContext["pool"],
      ...spanContext,
    };
    const sink = createDurableLifecycleEventSink(
      sinkContext,
      makeTestConfig({ agentEvents: { enabled: true } }),
    );
    const completion = sanitizeAgentLifecycleEvent({
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
    });
    if (!completion) throw new Error("expected a sanitized completion event");
    sink(completion);
    expect(analyticsMocks.appendAgentEvents).toHaveBeenCalledTimes(2);
    expect(analyticsMocks.appendAgentEvents).toHaveBeenNthCalledWith(1, expect.anything(), [
      expect.objectContaining({
        eventKind: "completion",
        detail: expect.objectContaining(cacheTokens),
      }),
    ]);
    expect(analyticsMocks.appendAgentEvents).toHaveBeenNthCalledWith(2, expect.anything(), [
      expect.objectContaining({
        eventKind: "generation",
        detail: expect.objectContaining(cacheTokens),
      }),
    ]);
    expect(analyticsMocks.captureEvent).not.toHaveBeenCalled();
    expect(analyticsMocks.recordExecutionSpan).not.toHaveBeenCalled();
  });
});
