import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { makeTestConfig } from "./helpers/config.js";
import {
  createFakePiSession,
  resetCreatePiSession,
  setCreatePiSession,
} from "../src/agent/runtime/piSession.js";
import { createFeaturePiSession } from "../src/agent/runtime/createFeatureSession.js";
import {
  resetAppendAgentEvents,
  setAppendAgentEvents,
  safeAppendAgentEvents,
  type AgentEventInsertRow,
  type AppendAgentEvents,
} from "../src/agentWork/agentEventsRepository.js";
import * as phaseCheckpoint from "../src/agentWork/phaseCheckpointRepository.js";
import * as resumeSnapshot from "../src/agentWork/resumeSnapshotRepository.js";
import type { PiSessionCreateParams } from "../src/agent/runtime/types.js";

const unusedPool = new Pool({ connectionString: "postgres://127.0.0.1:1/unused" });
const appendAgentEvents = vi.fn<AppendAgentEvents>(async () => undefined);

describe("createFeaturePiSession agent events", () => {
  beforeEach(() => {
    appendAgentEvents.mockReset();
    setAppendAgentEvents(appendAgentEvents);
    vi.spyOn(phaseCheckpoint, "getAgentPhaseCheckpoint").mockResolvedValue(null);
    vi.spyOn(phaseCheckpoint, "upsertAgentPhaseCheckpoint");
    vi.spyOn(resumeSnapshot, "upsertResumeSnapshot");
    vi.spyOn(resumeSnapshot, "loadResumeSnapshot").mockResolvedValue({
      ok: false,
      reason: "disabled",
    });
    vi.spyOn(resumeSnapshot, "deleteResumeSnapshotsForWorkItem");
    vi.spyOn(resumeSnapshot, "deleteResumeSnapshot");
    setCreatePiSession(async (params: PiSessionCreateParams) => {
      params.eventSink({
        kind: "turn",
        role: "orchestrator",
        phase: "recon",
        checkpointId: "orchestrator:recon",
        provider: "openai",
        model: "gpt-4o-mini",
      });
      return createFakePiSession(params).session;
    });
  });

  afterEach(() => {
    resetCreatePiSession();
    resetAppendAgentEvents();
    vi.restoreAllMocks();
  });

  const durability = {
    pool: unusedPool,
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
    const rows = appendAgentEvents.mock.calls[0]?.[1];
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
    resetAppendAgentEvents();
    const pool = new Pool({ connectionString: "postgres://127.0.0.1:1/unused" });
    vi.spyOn(pool, "query").mockRejectedValue(new Error("write failed"));
    const rows: AgentEventInsertRow[] = [
      {
        eventKind: "failure",
        provider: "openai",
        model: "gpt-4o-mini",
      },
    ];
    expect(() => safeAppendAgentEvents(pool, { agentEventsEnabled: true }, rows)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await pool.end();
  });
});
