import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestConfig } from "./helpers/config.js";

const {
  upsertResumeSnapshot,
  loadResumeSnapshot,
  deleteResumeSnapshotsForWorkItem,
  upsertAgentPhaseCheckpoint,
  createPiSession,
} = vi.hoisted(() => ({
  upsertResumeSnapshot: vi.fn(),
  loadResumeSnapshot: vi.fn(),
  deleteResumeSnapshotsForWorkItem: vi.fn(),
  upsertAgentPhaseCheckpoint: vi.fn(),
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
  getAgentPhaseCheckpoint: vi.fn(),
}));

vi.mock("../src/agent/runtime/piSession.js", () => ({
  createPiSession,
}));

import {
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
    loadResumeSnapshot.mockResolvedValue({
      ok: true,
      plaintext,
      checkpointId: "ask:ask",
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
    expect(loaded).toEqual({ ok: true, plaintext, checkpointId: "ask:ask" });
  });

  it("saveResumeSnapshotIfConfigured persists encrypted snapshot with stable versions", async () => {
    const cfg = makeTestConfig({
      agentResumeSnapshotKey: SNAPSHOT_KEY,
      queueRetryLimit: 2,
      queueRetryDelayMaxSeconds: 100,
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
    const expectedTtlMs = (2 * 100 + 50) * 1000;
    expect(call.expiresAt.getTime()).toBeGreaterThanOrEqual(before + expectedTtlMs - 1000);
    expect(call.expiresAt.getTime()).toBeLessThanOrEqual(after + expectedTtlMs + 1000);
  });

  it("clearResumeSnapshots deletes all snapshots for a work item", async () => {
    await clearResumeSnapshots({} as never, "wi-9");
    expect(deleteResumeSnapshotsForWorkItem).toHaveBeenCalledWith({}, "wi-9");
  });
});

describe("createFeaturePiSession durability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("restores structured state from resume snapshot on create", async () => {
    const cfg = makeTestConfig({ agentResumeSnapshotKey: SNAPSHOT_KEY });
    loadResumeSnapshot.mockResolvedValue({
      ok: true,
      checkpointId: "ask:ask",
      plaintext: {
        conversation: {},
        structuredState: { version: 2, payload: { cached: true } },
      },
    });
    createPiSession.mockImplementation(async (params) => {
      expect(params.structuredState).toEqual({
        version: 2,
        payload: { cached: true, __resumeCheckpointId: "ask:ask" },
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
