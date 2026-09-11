import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentAuditRecordFromLifecycleEvent } from "../src/agent/runtime/agentAudit.js";
import { sanitizeAgentLifecycleEvent } from "../src/agent/runtime/lifecycleSanitizer.js";

const analyticsMocks = vi.hoisted(() => ({
  captureEvent: vi.fn(),
  appendAgentEvents: vi.fn(async (..._args: unknown[]) => undefined),
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
      cfg: { agentEventsEnabled: boolean },
      rows: unknown[],
    ) => {
      if (!cfg.agentEventsEnabled || rows.length === 0) return;
      void analyticsMocks.appendAgentEvents(client, rows);
    },
  };
});

import {
  createDurableLifecycleEventSink,
  safeEmitPublishEvent,
  type AgentEventsContext,
} from "../src/agent/runtime/agentEventSink.js";
import {
  llmSpanFromSession,
  projectWorkSpanToPostHog,
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
    const projected = projectWorkSpanToPostHog(span);
    expect(projected.properties.$ai_parent_id).toBe("wi-span");
    expect(projected.properties).not.toHaveProperty("$ai_input_tokens");
    expect(projected.properties.$ai_latency).toBe(1.5);
  });

  it("omits a null parent id from PostHog properties", () => {
    const span = publishSpanFromContext({
      context: spanContext,
      publishStep: "batch-1",
      latencyMs: 40,
      isError: false,
      parentSpanId: null,
    });
    expect(projectWorkSpanToPostHog(span).properties).not.toHaveProperty("$ai_parent_id");
  });
});

describe("durable lifecycle span sink", () => {
  const context: AgentEventsContext = {
    pool: {} as AgentEventsContext["pool"],
    ...spanContext,
  };
  const cfg = { agentEventsEnabled: true };

  beforeEach(() => {
    analyticsMocks.captureEvent.mockClear();
    analyticsMocks.appendAgentEvents.mockClear();
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
      durationMs: 800,
      inputTokens: 12,
      outputTokens: 4,
    });
    expect(analyticsMocks.captureEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "$ai_generation",
        properties: expect.objectContaining({
          $ai_trace_id: "wi-span",
          $ai_parent_id: "wi-span",
          $ai_latency: 0.8,
          $ai_input_tokens: 12,
          $ai_output_tokens: 4,
        }),
      }),
    );
  });

  it("writes the same publish span id to Postgres and PostHog", () => {
    safeEmitPublishEvent(context, cfg, {
      specialist: "correctness",
      batchId: "batch-9",
      postedCount: 2,
      latencyMs: 250,
    });
    const captured = analyticsMocks.captureEvent.mock.calls[0]?.[0] as {
      event: string;
      properties: { $ai_span_id: string; $ai_parent_id: string; $ai_latency: number };
    };
    expect(captured.event).toBe("$ai_span");
    expect(captured.properties.$ai_parent_id).toBe("wi-span");
    expect(captured.properties.$ai_latency).toBe(0.25);
    const rows = analyticsMocks.appendAgentEvents.mock.calls[0]?.[1] as
      | Array<{
          eventKind: string;
          detail: { spanId: string; parentSpanId: string; latencyMs: number };
        }>
      | undefined;
    expect(rows?.[0]?.eventKind).toBe("publish");
    expect(rows?.[0]?.detail.spanId).toBe(captured.properties.$ai_span_id);
    expect(rows?.[0]?.detail.parentSpanId).toBe("wi-span");
    expect(rows?.[0]?.detail.latencyMs).toBe(250);
  });
});
