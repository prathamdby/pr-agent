import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { prepareCodeIndexForReview } from "../src/codeIndex/buildJob.js";
import type { LocalPrWorkspace } from "../src/prWorkspace/localPrWorkspace.js";

vi.mock("../src/codeIndex/repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/codeIndex/repository.js")>();
  return {
    ...actual,
    waitForReadySnapshot: vi.fn(),
    ensureBuildingSnapshot: vi.fn(),
    getSnapshotById: vi.fn(),
    replaceSnapshotChunks: vi.fn(),
    markSnapshotReady: vi.fn(),
    markSnapshotFailed: vi.fn(),
  };
});

import {
  ensureBuildingSnapshot,
  getSnapshotById,
  waitForReadySnapshot,
  markSnapshotReady,
  replaceSnapshotChunks,
} from "../src/codeIndex/repository.js";

const scope = {
  installationId: 1,
  owner: "acme",
  repo: "app",
  headSha: "abc123",
  prNumber: 9,
};

const workspace = {
  sortedCheckoutPaths: [],
  isPathInCheckout: () => false,
  agentCwd: "/tmp/ws",
} as unknown as LocalPrWorkspace;

const pathGate = {
  prChangedPaths: new Set<string>(),
  addPaths: () => undefined,
};

describe("prepareCodeIndexForReview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns available when a ready snapshot already exists and does not enqueue", async () => {
    vi.mocked(waitForReadySnapshot).mockResolvedValue({
      id: "snap-ready",
      status: "ready",
      chunkerVersion: "1",
    });
    const send = vi.fn();
    const boss = {
      createQueue: vi.fn(async () => undefined),
      send,
    } as unknown as PgBoss;

    const result = await prepareCodeIndexForReview({
      cfg: { codeIndexMode: "fts", codeIndexWaitMs: 50 } as never,
      pool: {} as Pool,
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
    // Inline build never finishes (markSnapshotReady hangs forever).
    vi.mocked(markSnapshotReady).mockImplementation(
      () => new Promise(() => undefined) as Promise<void>,
    );

    const connect = vi.fn(async () => ({
      query: vi.fn(async () => ({ rows: [] })),
      release: vi.fn(),
    }));
    const pool = { connect, query: vi.fn() } as unknown as Pool;

    const send = vi.fn(async () => "job-1");
    const boss = {
      createQueue: vi.fn(async () => undefined),
      send,
    } as unknown as PgBoss;

    const started = Date.now();
    const result = await prepareCodeIndexForReview({
      cfg: { codeIndexMode: "fts", codeIndexWaitMs: 40 } as never,
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
      cfg: { codeIndexMode: "off", codeIndexWaitMs: 3_000 } as never,
      pool: { query: vi.fn() } as unknown as Pool,
      scope,
      workspace,
      pathGate,
    });
    expect(result).toEqual({ available: false });
    expect(waitForReadySnapshot).not.toHaveBeenCalled();
  });
});
