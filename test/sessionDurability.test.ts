import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestConfig } from "./helpers/config.js";

const {
  upsertResumeSnapshot,
  loadResumeSnapshot,
  deleteResumeSnapshotsForWorkItem,
  upsertAgentPhaseCheckpoint,
  getAgentPhaseCheckpoint,
  createPiSession,
} = vi.hoisted(() => ({
  upsertResumeSnapshot: vi.fn(),
  loadResumeSnapshot: vi.fn(),
  deleteResumeSnapshotsForWorkItem: vi.fn(),
  upsertAgentPhaseCheckpoint: vi.fn(),
  getAgentPhaseCheckpoint: vi.fn(),
  createPiSession: vi.fn(),
}));

vi.mock("../src/agentWork/resumeSnapshotRepository.js", () => ({
  upsertResumeSnapshot,
  loadResumeSnapshot,
  deleteResumeSnapshotsForWorkItem,
  deleteResumeSnapshot: vi.fn(),
}));

vi.mock("../src/agentWork/phaseCheckpointRepository.js", () => ({
  upsertAgentPhaseCheckpoint,
  getAgentPhaseCheckpoint,
}));

vi.mock("../src/agent/runtime/piSession.js", () => ({
  createPiSession,
}));

import {
  checkpointOutranksSnapshot,
  clearResumeSnapshots,
  loadResumeSnapshotIfConfigured,
  RESUME_SNAPSHOT_PROMPT_VERSION,
  RESUME_SNAPSHOT_SDK_VERSION,
  RESUME_SNAPSHOT_TOOL_POLICY_VERSION,
  saveResumeSnapshotIfConfigured,
} from "../src/agent/runtime/sessionDurability.js";
import { createFeaturePiSession } from "../src/agent/runtime/createFeatureSession.js";
import type { PiSession } from "../src/agent/runtime/types.js";

const SNAPSHOT_KEY = Buffer.alloc(32, 3).toString("base64");

function fakeSession(overrides: Partial<PiSession> = {}): PiSession {
  let structuredState = { version: 1, payload: { step: "recon" as const } };
  return {
    role: "ask",
    primary: { provider: "openai", model: "gpt-4o-mini" },
    send: vi.fn(async () => ({ text: "ok", toolCalls: [], usage: undefined })),
    setActiveTools: vi.fn(),
    restoreTools: vi.fn(),
    abort: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    restartWithFallback: vi.fn(),
    getStructuredState: () => structuredState,
    setStructuredState: (state) => {
      structuredState = state as typeof structuredState;
    },
    setExternalMutationPending: vi.fn(),
    compactIfNeeded: vi.fn(async () => false),
    ...overrides,
  };
}

describe("sessionDurability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createPiSession.mockResolvedValue(fakeSession());
    getAgentPhaseCheckpoint.mockResolvedValue(null);
  });

  it("saveResumeSnapshotIfConfigured no-ops without key", async () => {
    const cfg = makeTestConfig({ agentResumeSnapshotKey: "" });
    await saveResumeSnapshotIfConfigured({} as never, cfg, {
      workItemId: "wi-1",
      sessionRole: "ask",
      installationId: 1,
      modelProvider: "openai",
      modelId: "gpt-4o-mini",
      checkpointId: "ask:ask",
      plaintext: { conversation: {}, structuredState: { version: 1, payload: {} } },
    });
    expect(upsertResumeSnapshot).not.toHaveBeenCalled();
  });

  it("loadResumeSnapshotIfConfigured returns disabled without key", async () => {
    const cfg = makeTestConfig({ agentResumeSnapshotKey: "" });
    const result = await loadResumeSnapshotIfConfigured({} as never, cfg, {
      workItemId: "wi-1",
      sessionRole: "ask",
      expectedInstallationId: 1,
    });
    expect(result).toEqual({ ok: false, reason: "disabled" });
    expect(loadResumeSnapshot).not.toHaveBeenCalled();
  });

  it("round-trips load with key via repository wrapper", async () => {
    const cfg = makeTestConfig({ agentResumeSnapshotKey: SNAPSHOT_KEY });
    const plaintext = {
      conversation: { lastPhase: "ask", lastCheckpointId: "ask:ask" },
      structuredState: { version: 1, payload: { answer: "cached" } },
    };
    const updatedAt = new Date("2026-07-01T00:00:00.000Z");
    loadResumeSnapshot.mockResolvedValue({
      ok: true,
      plaintext,
      checkpointId: "ask:ask",
      updatedAt,
    });

    const loaded = await loadResumeSnapshotIfConfigured({} as never, cfg, {
      workItemId: "wi-1",
      sessionRole: "ask",
      expectedInstallationId: 42,
    });

    expect(loadResumeSnapshot).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        keyMaterial: SNAPSHOT_KEY,
        workItemId: "wi-1",
        sessionRole: "ask",
        expectedInstallationId: 42,
      }),
    );
    expect(loaded).toEqual({ ok: true, plaintext, checkpointId: "ask:ask", updatedAt });
  });

  it("saveResumeSnapshotIfConfigured persists encrypted snapshot with stable versions", async () => {
    const cfg = makeTestConfig({
      agentResumeSnapshotKey: SNAPSHOT_KEY,
      queueRetryLimit: 2,
      queueRetryDelayMaxSeconds: 100,
      queueExpireInSeconds: 3600,
      agentResumeSnapshotMarginSeconds: 50,
    });
    const before = Date.now();
    await saveResumeSnapshotIfConfigured({} as never, cfg, {
      workItemId: "wi-1",
      sessionRole: "orchestrator",
      installationId: 9,
      modelProvider: "openai",
      modelId: "gpt-4o",
      checkpointId: "orchestrator:recon",
      plaintext: {
        conversation: { lastPhase: "recon", lastCheckpointId: "orchestrator:recon" },
        structuredState: { version: 1, payload: {} },
      },
    });
    const after = Date.now();

    expect(upsertResumeSnapshot).toHaveBeenCalledTimes(1);
    const call = upsertResumeSnapshot.mock.calls[0]?.[1];
    expect(call).toMatchObject({
      keyMaterial: SNAPSHOT_KEY,
      workItemId: "wi-1",
      sessionRole: "orchestrator",
      installationId: 9,
      sdkVersion: RESUME_SNAPSHOT_SDK_VERSION,
      promptVersion: RESUME_SNAPSHOT_PROMPT_VERSION,
      toolPolicyVersion: RESUME_SNAPSHOT_TOOL_POLICY_VERSION,
      checkpointId: "orchestrator:recon",
    });
    const expectedTtlMs = (2 * 100 + 3600 + 50) * 1000;
    expect(call.expiresAt.getTime()).toBeGreaterThanOrEqual(before + expectedTtlMs - 1000);
    expect(call.expiresAt.getTime()).toBeLessThanOrEqual(after + expectedTtlMs + 1000);
  });

  it("clearResumeSnapshots deletes all snapshots for a work item", async () => {
    await clearResumeSnapshots({} as never, "wi-9");
    expect(deleteResumeSnapshotsForWorkItem).toHaveBeenCalledWith({}, "wi-9");
  });

  it("checkpointOutranksSnapshot prefers later phase, then version, then updated_at", () => {
    const base = {
      checkpointPhase: "judgment",
      checkpointVersion: 2,
      checkpointUpdatedAt: new Date("2026-07-02T00:00:00.000Z"),
      snapshotPhase: "recon",
      snapshotVersion: 9,
      snapshotUpdatedAt: new Date("2026-07-03T00:00:00.000Z"),
    };
    expect(checkpointOutranksSnapshot(base)).toBe(true);
    expect(
      checkpointOutranksSnapshot({
        ...base,
        checkpointPhase: "recon",
        snapshotPhase: "judgment",
      }),
    ).toBe(false);
    expect(
      checkpointOutranksSnapshot({
        ...base,
        checkpointPhase: "recon",
        snapshotPhase: "recon",
        checkpointVersion: 3,
        snapshotVersion: 2,
      }),
    ).toBe(true);
    expect(
      checkpointOutranksSnapshot({
        ...base,
        checkpointPhase: "recon",
        snapshotPhase: "recon",
        checkpointVersion: 2,
        snapshotVersion: 2,
        checkpointUpdatedAt: new Date("2026-07-04T00:00:00.000Z"),
        snapshotUpdatedAt: new Date("2026-07-03T00:00:00.000Z"),
      }),
    ).toBe(true);
  });
});

describe("createFeaturePiSession durability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAgentPhaseCheckpoint.mockResolvedValue(null);
  });

  it("restores structured state from resume snapshot when no checkpoint exists", async () => {
    const cfg = makeTestConfig({ agentResumeSnapshotKey: SNAPSHOT_KEY });
    loadResumeSnapshot.mockResolvedValue({
      ok: true,
      checkpointId: "ask:ask",
      updatedAt: new Date("2026-07-01T00:00:00.000Z"),
      plaintext: {
        conversation: { lastPhase: "ask" },
        structuredState: { version: 2, payload: { cached: true } },
      },
    });
    createPiSession.mockImplementation(async (params) => {
      expect(params.structuredState).toEqual({
        version: 2,
        payload: {
          cached: true,
          __resumeCheckpointId: "ask:ask",
          __lastCompletedPhase: "ask",
          __resumeConversation: { lastPhase: "ask" },
        },
      });
      return fakeSession({ getStructuredState: () => params.structuredState });
    });

    await createFeaturePiSession({
      role: "ask",
      cfg,
      systemPrompt: "system",
      tools: [],
      executors: {},
      durability: { pool: {} as never, workItemId: "wi-1", installationId: 1 },
    });
  });

  it("restores authoritative checkpoint when snapshot encryption is disabled", async () => {
    const cfg = makeTestConfig({ agentResumeSnapshotKey: "" });
    getAgentPhaseCheckpoint.mockResolvedValue({
      id: "cp-1",
      workItemId: "wi-1",
      sessionRole: "orchestrator",
      checkpointId: "orchestrator:judgment",
      phase: "judgment",
      structuredState: { version: 4, payload: { briefAccepted: true, publishedBatches: ["b1"] } },
      version: 4,
      updatedAt: new Date("2026-07-02T00:00:00.000Z"),
    });
    createPiSession.mockImplementation(async (params) => {
      expect(params.structuredState).toEqual({
        version: 4,
        payload: {
          briefAccepted: true,
          publishedBatches: ["b1"],
          __resumeCheckpointId: "orchestrator:judgment",
          __lastCompletedPhase: "judgment",
        },
      });
      expect(loadResumeSnapshot).not.toHaveBeenCalled();
      return fakeSession({ role: "orchestrator", getStructuredState: () => params.structuredState });
    });

    await createFeaturePiSession({
      role: "orchestrator",
      cfg,
      systemPrompt: "system",
      tools: [],
      executors: {},
      durability: { pool: {} as never, workItemId: "wi-1", installationId: 1 },
    });
  });

  it("prefers newer checkpoint structured state over older snapshot state", async () => {
    const cfg = makeTestConfig({ agentResumeSnapshotKey: SNAPSHOT_KEY });
    getAgentPhaseCheckpoint.mockResolvedValue({
      id: "cp-1",
      workItemId: "wi-1",
      sessionRole: "orchestrator",
      checkpointId: "orchestrator:judgment",
      phase: "judgment",
      structuredState: { version: 5, payload: { fromCheckpoint: true, phaseDone: "judgment" } },
      version: 5,
      updatedAt: new Date("2026-07-03T00:00:00.000Z"),
    });
    loadResumeSnapshot.mockResolvedValue({
      ok: true,
      checkpointId: "orchestrator:recon",
      updatedAt: new Date("2026-07-01T00:00:00.000Z"),
      plaintext: {
        conversation: { lastPhase: "recon", lastCheckpointId: "orchestrator:recon" },
        structuredState: { version: 1, payload: { fromSnapshot: true, shouldNotWin: true } },
      },
    });
    createPiSession.mockImplementation(async (params) => {
      expect(params.structuredState.payload.fromCheckpoint).toBe(true);
      expect(params.structuredState.payload.fromSnapshot).toBeUndefined();
      expect(params.structuredState.payload.shouldNotWin).toBeUndefined();
      expect(params.structuredState.payload.__lastCompletedPhase).toBe("judgment");
      expect(params.structuredState.payload.__resumeConversation).toEqual({
        lastPhase: "recon",
        lastCheckpointId: "orchestrator:recon",
      });
      return fakeSession({ role: "orchestrator", getStructuredState: () => params.structuredState });
    });

    await createFeaturePiSession({
      role: "orchestrator",
      cfg,
      systemPrompt: "system",
      tools: [],
      executors: {},
      durability: { pool: {} as never, workItemId: "wi-1", installationId: 1 },
    });
  });

  it("does not attach older snapshot conversation when checkpoint phase is behind", async () => {
    const cfg = makeTestConfig({ agentResumeSnapshotKey: SNAPSHOT_KEY });
    getAgentPhaseCheckpoint.mockResolvedValue({
      id: "cp-1",
      workItemId: "wi-1",
      sessionRole: "orchestrator",
      checkpointId: "orchestrator:recon",
      phase: "recon",
      structuredState: { version: 1, payload: { fromCheckpoint: true } },
      version: 1,
      updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    });
    loadResumeSnapshot.mockResolvedValue({
      ok: true,
      checkpointId: "orchestrator:synthesis",
      updatedAt: new Date("2026-07-04T00:00:00.000Z"),
      plaintext: {
        conversation: { lastPhase: "synthesis" },
        structuredState: { version: 9, payload: { fromSnapshot: true } },
      },
    });
    createPiSession.mockImplementation(async (params) => {
      expect(params.structuredState.payload.fromCheckpoint).toBe(true);
      expect(params.structuredState.payload.__resumeConversation).toBeUndefined();
      expect(params.structuredState.payload.__lastCompletedPhase).toBe("recon");
      return fakeSession({ role: "orchestrator", getStructuredState: () => params.structuredState });
    });

    await createFeaturePiSession({
      role: "orchestrator",
      cfg,
      systemPrompt: "system",
      tools: [],
      executors: {},
      durability: { pool: {} as never, workItemId: "wi-1", installationId: 1 },
    });
  });

  it("wrapped send commits phase checkpoint and resume snapshot after success", async () => {
    const cfg = makeTestConfig({ agentResumeSnapshotKey: SNAPSHOT_KEY });
    loadResumeSnapshot.mockResolvedValue({ ok: false, reason: "missing" });
    const session = fakeSession();
    createPiSession.mockResolvedValue(session);

    const wrapped = await createFeaturePiSession({
      role: "ask",
      cfg,
      systemPrompt: "system",
      tools: [],
      executors: {},
      durability: { pool: {} as never, workItemId: "wi-1", installationId: 7 },
    });

    await wrapped.send("hello", { phase: "ask", checkpointId: "ask:ask" });

    expect(upsertAgentPhaseCheckpoint).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        workItemId: "wi-1",
        sessionRole: "ask",
        checkpointId: "ask:ask",
        phase: "ask",
        structuredState: { version: 1, payload: { step: "recon" } },
      }),
    );
    expect(upsertResumeSnapshot).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        workItemId: "wi-1",
        sessionRole: "ask",
        installationId: 7,
        checkpointId: "ask:ask",
        plaintext: {
          conversation: { lastPhase: "ask", lastCheckpointId: "ask:ask" },
          structuredState: { version: 1, payload: { step: "recon" } },
        },
      }),
    );
  });
});
