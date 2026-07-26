import { describe, expect, it, vi, beforeEach } from "vitest";
import { makeTestConfig } from "./helpers/config.js";

const { appendAgentEvents, getAgentPhaseCheckpoint } = vi.hoisted(() => ({
  appendAgentEvents: vi.fn(async (..._args: unknown[]) => undefined),
  getAgentPhaseCheckpoint: vi.fn(async () => null),
}));

vi.mock("../src/agentWork/phaseCheckpointRepository.js", () => ({
  upsertAgentPhaseCheckpoint: vi.fn(),
  getAgentPhaseCheckpoint,
}));

vi.mock("../src/agentWork/resumeSnapshotRepository.js", () => ({
  upsertResumeSnapshot: vi.fn(),
  loadResumeSnapshot: vi.fn(async () => ({ ok: false, reason: "disabled" })),
  deleteResumeSnapshotsForWorkItem: vi.fn(),
  deleteResumeSnapshot: vi.fn(),
}));

vi.mock("../src/agentWork/agentEventsRepository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agentWork/agentEventsRepository.js")>();
  return {
    ...actual,
    appendAgentEvents,
    safeAppendAgentEvents: (
      client: unknown,
      cfg: { agentEventsEnabled: boolean },
      rows: unknown[],
    ) => {
      if (!cfg.agentEventsEnabled || rows.length === 0) return;
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
    return {
      role: "orchestrator",
      primary: { provider: "openai", model: "gpt-4o-mini" },
      send: vi.fn(),
      abort: vi.fn(),
      dispose: vi.fn(),
      getStructuredState: () => ({ version: 1, payload: {} }),
      restoreTools: vi.fn(),
      setActiveTools: vi.fn(),
    };
  }),
  DEFAULT_COMPACTION_POLICY: {},
  DEFAULT_TOOL_POLICY: {},
  EMPTY_STRUCTURED_STATE: { version: 1, payload: {} },
}));

import { createFeaturePiSession } from "../src/agent/runtime/createFeatureSession.js";
import { safeAppendAgentEvents } from "../src/agentWork/agentEventsRepository.js";

describe("createFeaturePiSession agent events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const durability = {
    pool: {} as never,
    workItemId: "wi-1",
    installationId: 99,
    owner: "acme",
    repo: "app",
    prNumber: 12,
  };

  it("wires durable lifecycle sink when enabled and context is complete", async () => {
    const cfg = makeTestConfig({ agentEventsEnabled: true });
    await createFeaturePiSession({
      role: "orchestrator",
      cfg,
      systemPrompt: "system",
      tools: [],
      executors: {},
      durability,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(appendAgentEvents).toHaveBeenCalledTimes(1);
    const rows = appendAgentEvents.mock.calls[0]?.[1] as Array<{ eventKind: string }> | undefined;
    expect(rows?.[0]?.eventKind).toBe("turn");
  });

  it("skips durable sink when agent events are disabled", async () => {
    const cfg = makeTestConfig({ agentEventsEnabled: false });
    await createFeaturePiSession({
      role: "orchestrator",
      cfg,
      systemPrompt: "system",
      tools: [],
      executors: {},
      durability,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(appendAgentEvents).not.toHaveBeenCalled();
  });

  it("does not throw when writer fails", async () => {
    appendAgentEvents.mockRejectedValueOnce(new Error("db down"));
    const cfg = makeTestConfig({ agentEventsEnabled: true });

    await expect(
      createFeaturePiSession({
        role: "orchestrator",
        cfg,
        systemPrompt: "system",
        tools: [],
        executors: {},
        durability,
      }),
    ).resolves.toBeDefined();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(appendAgentEvents).toHaveBeenCalledTimes(1);
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
      safeAppendAgentEvents(pool as never, { agentEventsEnabled: true }, [
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
