import { describe, expect, it, vi, beforeEach } from "vitest";
import { prepareCodeIndexForReview } from "../src/codeIndex/buildJob.js";
import type {
  CodeIndexBoss,
  CodeIndexPool,
  CodeIndexWorkspace,
} from "../src/codeIndex/buildJob.js";
import * as codeIndexRepository from "../src/codeIndex/repository.js";
import {
  ensureBuildingSnapshot,
  getSnapshotById,
  waitForReadySnapshot,
  markSnapshotReady,
  replaceSnapshotChunks,
} from "../src/codeIndex/repository.js";
import { makeTestConfig } from "./helpers/config.js";

function unusedCodeIndexPool(): CodeIndexPool {
  return {
    query: async () => {
      throw new Error("test pool: unused");
    },
    connect: async () => {
      throw new Error("test pool: unused");
    },
  };
}

const scope = {
  installationId: 1,
  owner: "acme",
  repo: "app",
  headSha: "abc123",
  prNumber: 9,
};

const workspace: CodeIndexWorkspace = {
  sortedCheckoutPaths: [],
  isPathInCheckout: () => false,
  agentCwd: "/tmp/ws",
};

const pathGate = {
  prChangedPaths: new Set<string>(),
  addPaths: () => undefined,
};

describe("prepareCodeIndexForReview", () => {
  beforeEach(() => {
    vi.spyOn(codeIndexRepository, "waitForReadySnapshot");
    vi.spyOn(codeIndexRepository, "ensureBuildingSnapshot");
    vi.spyOn(codeIndexRepository, "getSnapshotById");
    vi.spyOn(codeIndexRepository, "replaceSnapshotChunks");
    vi.spyOn(codeIndexRepository, "markSnapshotReady");
    vi.spyOn(codeIndexRepository, "markSnapshotFailed");
    vi.clearAllMocks();
  });

  it("returns available when a ready snapshot already exists and does not enqueue", async () => {
    vi.mocked(waitForReadySnapshot).mockResolvedValue({
      id: "snap-ready",
      status: "ready",
      chunkerVersion: "1",
    });
    const send = vi.fn();
    const boss: CodeIndexBoss = {
      createQueue: vi.fn(async () => undefined),
      send,
    };

    const result = await prepareCodeIndexForReview({
      cfg: makeTestConfig({ codeIndexMode: "fts", codeIndexWaitMs: 50 }),
      pool: unusedCodeIndexPool(),
      boss,
      scope,
      workspace,
      pathGate,
    });

    expect(result).toEqual({ available: true, snapshotId: "snap-ready" });
    expect(send).not.toHaveBeenCalled();
    expect(ensureBuildingSnapshot).not.toHaveBeenCalled();
  });

  it("returns unavailable within wait budget and enqueues a background job once", async () => {
    vi.mocked(waitForReadySnapshot).mockResolvedValue(null);
    vi.mocked(ensureBuildingSnapshot).mockResolvedValue({
      id: "snap-building",
      status: "building",
      chunkerVersion: "1",
    });
    vi.mocked(getSnapshotById).mockResolvedValue({
      id: "snap-building",
      status: "building",
      chunkerVersion: "1",
    });
    vi.mocked(replaceSnapshotChunks).mockResolvedValue(undefined);
    vi.mocked(markSnapshotReady).mockImplementation(() => new Promise(() => undefined));

    const client = {
      query: vi.fn(async () => ({ rows: [] })),
      release: vi.fn(),
    };
    const pool: CodeIndexPool = {
      query: vi.fn(async () => ({ rows: [] })),
      connect: vi.fn(async () => client),
    };

    const send = vi.fn(async () => "job-1");
    const boss: CodeIndexBoss = {
      createQueue: vi.fn(async () => undefined),
      send,
    };

    const started = Date.now();
    const result = await prepareCodeIndexForReview({
      cfg: makeTestConfig({ codeIndexMode: "fts", codeIndexWaitMs: 40 }),
      pool,
      boss,
      scope,
      workspace,
      pathGate,
    });
    const elapsed = Date.now() - started;

    expect(result).toEqual({ available: false });
    expect(elapsed).toBeLessThan(1000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("returns unavailable when mode is off without querying", async () => {
    const result = await prepareCodeIndexForReview({
      cfg: makeTestConfig({ codeIndexMode: "off", codeIndexWaitMs: 3_000 }),
      pool: unusedCodeIndexPool(),
      scope,
      workspace,
      pathGate,
    });
    expect(result).toEqual({ available: false });
    expect(waitForReadySnapshot).not.toHaveBeenCalled();
  });
});
