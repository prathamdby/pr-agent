import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AgentEventInsertRow } from "../src/analytics/workSpan.ts";
import { makeTestConfig } from "./helpers/config.ts";

const { loggedEvents, logInfoMock, fakePiSession } = vi.hoisted(() => {
  const loggedEvents: AgentEventInsertRow[] = [];
  const logInfoMock = vi.fn((event: string, data?: Record<string, unknown>) => {
    if (event === "agent_event" && data != null) {
      loggedEvents.push(data as unknown as AgentEventInsertRow);
    }
  });
  function fakePiSession() {
    return ((pinnedReturn: {
      role: "orchestrator";
      primary: { provider: "openai"; model: "gpt-4o-mini" };
      send: ReturnType<typeof vi.fn>;
      abort: ReturnType<typeof vi.fn>;
      dispose: ReturnType<typeof vi.fn>;
    }) => pinnedReturn)({
      role: "orchestrator",
      primary: { provider: "openai", model: "gpt-4o-mini" },
      send: vi.fn(),
      abort: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
    });
  }
  return { loggedEvents, logInfoMock, fakePiSession };
});

vi.mock("../src/evlog.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/evlog.ts")>();
  return {
    ...actual,
    logInfo: logInfoMock,
  };
});

vi.mock("../src/agent/runtime/piSession.ts", () => ({
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

import { createFeaturePiSession } from "../src/agent/runtime/createFeatureSession.ts";
import { createPiSession } from "../src/agent/runtime/piSession.ts";
import { safeEmitAgentEvent } from "../src/agent/runtime/agentEventSink.ts";
import { createFakePiSession } from "../src/agent/runtime/fakePiSession.ts";

describe("createFeaturePiSession agent events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loggedEvents.length = 0;
  });

  const sessionContext = {
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

    expect(loggedEvents).toHaveLength(1);
    expect(loggedEvents[0]?.eventKind).toBe("turn");
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
    expect(loggedEvents).toHaveLength(0);
  });

  it.each([false, true])(
    "records each send on the audit trail when agent events are enabled (%s)",
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
      const generations = loggedEvents.filter((row) => row.eventKind === "generation");
      if (!enabled) {
        expect(generations).toEqual([]);
        return;
      }
      expect(generations).toHaveLength(3);
      expect(generations[0]).toMatchObject({
        provider: "anthropic",
        model: "fallback",
        detail: {
          specialistId: "security",
          executionId: "execution-1",
          attemptCount: 2,
        },
      });
      expect(new Set(generations.map((row) => row.detail?.spanId)).size).toBe(3);
      expect(generations[0]?.detail?.sessionId).toBe(generations[1]?.detail?.sessionId);
      expect(generations[0]?.detail?.sessionId).not.toBe(generations[2]?.detail?.sessionId);
      expect(generations[0]?.detail?.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(generations[0]?.detail?.inputTokens).toBeUndefined();
      expect(JSON.stringify(generations)).not.toContain("private");
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
    const turnId = events.find((event) => event.kind === "turn")?.generationId;
    const failureId = events.find((event) => event.kind === "failure")?.generationId;
    expect(turnId).toBeTruthy();
    expect(failureId).toBe(turnId);
  });

  it("does not throw when writer fails", async () => {
    logInfoMock.mockImplementationOnce(() => {
      throw new Error("sink down");
    });
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

    expect(logInfoMock).toHaveBeenCalledTimes(1);
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

describe("safeEmitAgentEvent isolation", () => {
  it("never throws to callers", () => {
    logInfoMock.mockImplementationOnce(() => {
      throw new Error("write failed");
    });
    expect(() =>
      safeEmitAgentEvent(
        {
          workItemId: "wi-1",
          installationId: 99,
          owner: "acme",
          repo: "app",
          prNumber: 12,
        },
        makeTestConfig({ agentEvents: { enabled: true } }),
        {
          eventKind: "failure",
          provider: "openai",
          model: "gpt-4o-mini",
        },
      ),
    ).not.toThrow();
  });
});
