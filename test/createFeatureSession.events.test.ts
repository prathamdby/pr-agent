import { describe, expect, it, vi, beforeEach } from "vitest";
import { makeTestConfig } from "./helpers/config.js";

const { appendAgentEvents, fakePiSession } = vi.hoisted(() => {
  function fakePiSession(): {
    role: "orchestrator";
    primary: { provider: "openai"; model: "gpt-4o-mini" };
    send: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  } {
    return {
      role: "orchestrator",
      primary: { provider: "openai", model: "gpt-4o-mini" },
      send: vi.fn(),
      abort: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
    };
  }
  return {
    appendAgentEvents: vi.fn(async (..._args: unknown[]) => undefined),
    fakePiSession,
  };
});

vi.mock("../src/agentWork/agentEventsRepository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agentWork/agentEventsRepository.js")>();
  return {
    ...actual,
    appendAgentEvents,
    safeAppendAgentEvents: (
      client: unknown,
      cfg: { agentEvents: { enabled: boolean } },
      rows: unknown[],
    ) => {
      if (!cfg.agentEvents.enabled || rows.length === 0) return;
      void appendAgentEvents(client, rows).catch(() => undefined);
    },
  };
});

vi.mock("../src/agent/runtime/piSession.js", () => ({
  createPiSession: vi.fn(async (params: { eventSink: (event: unknown) => void }) => {
    params.eventSink({
      kind: "turn",
      role: "orchestrator",
      phase: "recon",
      checkpointId: "orchestrator:recon",
      provider: "openai",
      model: "gpt-4o-mini",
    });
    return fakePiSession();
  }),
  DEFAULT_TOOL_POLICY: {},
}));

import { createFeaturePiSession } from "../src/agent/runtime/createFeatureSession.js";
import { createPiSession } from "../src/agent/runtime/piSession.js";
import { safeAppendAgentEvents } from "../src/agentWork/agentEventsRepository.js";
import { captureWorkSpan } from "../src/analytics/workSpan.js";
import { createFakePiSession } from "../src/agent/runtime/fakePiSession.js";

vi.mock("../src/analytics/workSpan.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/analytics/workSpan.js")>()),
  captureWorkSpan: vi.fn(),
}));

describe("createFeaturePiSession agent events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const sessionContext = {
    pool: {} as never,
    workItemId: "wi-1",
    installationId: 99,
    owner: "acme",
    repo: "app",
    prNumber: 12,
  };

  it("wires durable lifecycle sink when enabled and context is complete", async () => {
    const cfg = makeTestConfig({ agentEvents: { enabled: true } });
    await createFeaturePiSession({
      role: "orchestrator",
      cfg,
      systemPrompt: "system",
      tools: [],
      executors: {},
      sessionContext,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(appendAgentEvents).toHaveBeenCalledTimes(1);
    const rows = appendAgentEvents.mock.calls[0]?.[1] as Array<{ eventKind: string }> | undefined;
    expect(rows?.[0]?.eventKind).toBe("turn");
  });

  it("skips durable sink when agent events are disabled", async () => {
    const cfg = makeTestConfig({ agentEvents: { enabled: false } });
    await createFeaturePiSession({
      role: "orchestrator",
      cfg,
      systemPrompt: "system",
      tools: [],
      executors: {},
      sessionContext,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(appendAgentEvents).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "captures each send with actual fallback identity independently of audit (%s)",
    async (enabled) => {
      const cfg = makeTestConfig({ agentEvents: { enabled } });
      const createSession = (params: Parameters<typeof createFakePiSession>[0]) =>
        createFakePiSession(params, () => "").session;
      const first = await createFeaturePiSession({
        createSession,
        role: "specialist",
        specialistId: "security",
        cfg,
        systemPrompt: "system",
        tools: [],
        executors: {},
        attemptModel: { provider: "anthropic", model: "fallback" },
        sessionContext: { ...sessionContext, executionId: "execution-1", attemptCount: 2 },
      });
      const second = await createFeaturePiSession({
        createSession,
        role: "specialist",
        specialistId: "security",
        cfg,
        systemPrompt: "system",
        tools: [],
        executors: {},
        sessionContext,
      });
      await first.send("private prompt", { phase: "specialist", checkpointId: "same" });
      await first.send("private repair", { phase: "validation_repair", checkpointId: "same" });
      await second.send("another work", { phase: "specialist", checkpointId: "same" });
      const spans = vi.mocked(captureWorkSpan).mock.calls.map(([span]) => span);
      expect(spans).toHaveLength(3);
      expect(spans[0]).toMatchObject({
        kind: "llm_generation",
        provider: "anthropic",
        model: "fallback",
        specialistId: "security",
        executionId: "execution-1",
        attemptCount: 2,
      });
      expect(new Set(spans.map((span) => span.spanId)).size).toBe(3);
      expect(spans[0]?.sessionId).toBe(spans[1]?.sessionId);
      expect(spans[0]?.sessionId).not.toBe(spans[2]?.sessionId);
      expect(spans[0]?.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(spans[0]).not.toHaveProperty("inputTokens");
      expect(appendAgentEvents.mock.calls.length > 0).toBe(enabled);
      expect(JSON.stringify(spans)).not.toContain("private");
    },
  );

  it("keeps failed sends observable without allowing a throwing observer to fail work", async () => {
    const cfg = makeTestConfig({ agentEvents: { enabled: false } });
    const events: Array<{ kind: string; generationId?: string }> = [];
    const session = await createFeaturePiSession({
      createSession: (params) =>
        createFakePiSession(params, () => {
          throw new Error("provider failed");
        }).session,
      role: "ask",
      cfg,
      systemPrompt: "system",
      tools: [],
      executors: {},
      sessionContext,
      eventSink: (event) => {
        events.push(event);
        throw new Error("observer down");
      },
    });
    await expect(session.send("private", { phase: "ask", checkpointId: "ask" })).rejects.toThrow(
      "provider failed",
    );
    expect(vi.mocked(captureWorkSpan)).toHaveBeenCalledTimes(1);
    const span = vi.mocked(captureWorkSpan).mock.calls[0]?.[0];
    expect(span?.isError).toBe(true);
    expect(events.find((event) => event.kind === "turn")?.generationId).toBe(span?.spanId);
    expect(events.find((event) => event.kind === "failure")?.generationId).toBe(span?.spanId);
  });

  it("does not throw when writer fails", async () => {
    appendAgentEvents.mockRejectedValueOnce(new Error("db down"));
    const cfg = makeTestConfig({ agentEvents: { enabled: true } });

    await expect(
      createFeaturePiSession({
        role: "orchestrator",
        cfg,
        systemPrompt: "system",
        tools: [],
        executors: {},
        sessionContext,
      }),
    ).resolves.toBeDefined();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(appendAgentEvents).toHaveBeenCalledTimes(1);
  });

  it("wires execute abort through session.abort", async () => {
    const cfg = makeTestConfig({ agentEvents: { enabled: false } });
    let seenSignal: AbortSignal | undefined;
    const session = await createFeaturePiSession({
      role: "orchestrator",
      cfg,
      systemPrompt: "system",
      tools: [],
      executors: {
        execute: async (_args, ctx) => {
          seenSignal = ctx?.signal;
          return { ok: true };
        },
      },
      sessionContext,
    });
    const wrappedExecute = vi.mocked(createPiSession).mock.calls.at(-1)?.[0]?.executors?.execute;
    expect(typeof wrappedExecute).toBe("function");

    await session.abort();
    await wrappedExecute!({});
    expect(seenSignal?.aborted).toBe(true);
  });
});

describe("safeAppendAgentEvents isolation", () => {
  it("never throws to callers", async () => {
    const pool = {
      query: vi.fn(async () => {
        throw new Error("write failed");
      }),
    };
    expect(() =>
      safeAppendAgentEvents(pool as never, makeTestConfig({ agentEvents: { enabled: true } }), [
        {
          eventKind: "failure",
          provider: "openai",
          model: "gpt-4o-mini",
        },
      ]),
    ).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
