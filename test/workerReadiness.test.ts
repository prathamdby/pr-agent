import { describe, expect, it, vi } from "vitest";
import {
  evaluateWorkerReadiness,
  type WorkerReadinessState,
} from "../src/agentWork/workerReadiness.js";
import { ACK_QUEUE } from "../src/settings/index.js";

function makeBoss(overrides: {
  wip?: Array<{
    state: string;
    lastFetchedOn: number | null;
    createdOn: number;
  }>;
  getQueue?: () => Promise<unknown>;
}) {
  return {
    getWipData: () => overrides.wip ?? [],
    getQueue: overrides.getQueue ?? (async () => ({ name: ACK_QUEUE })),
  };
}

function makePool(ok = true) {
  return {
    query: vi.fn(async () => {
      if (!ok) throw new Error("db down");
      return { rows: [{ "?column?": 1 }] };
    }),
  };
}

describe("evaluateWorkerReadiness", () => {
  const now = 1_000_000;

  it("fails when consumers are not registered even if process deps look fine", async () => {
    const state: WorkerReadinessState = { consumersRegistered: false };
    const result = await evaluateWorkerReadiness({
      pool: makePool() as never,
      boss: makeBoss({
        wip: [{ state: "active", lastFetchedOn: now, createdOn: now }],
      }) as never,
      state,
      pollStaleSeconds: 30,
      nowMs: () => now,
    });
    expect(result).toEqual({ ready: false, reason: "consumers_not_registered" });
  });

  it("reports ready for idle workers with empty queues when consumers poll", async () => {
    const state: WorkerReadinessState = { consumersRegistered: true };
    const result = await evaluateWorkerReadiness({
      pool: makePool() as never,
      boss: makeBoss({
        wip: [{ state: "active", lastFetchedOn: now - 5_000, createdOn: now - 60_000 }],
        getQueue: async () => ({ name: ACK_QUEUE, queuedCount: 0, activeCount: 0 }),
      }) as never,
      state,
      pollStaleSeconds: 30,
      nowMs: () => now,
    });
    expect(result).toEqual({ ready: true });
  });

  it("fails when polling is stale", async () => {
    const state: WorkerReadinessState = { consumersRegistered: true };
    const result = await evaluateWorkerReadiness({
      pool: makePool() as never,
      boss: makeBoss({
        wip: [{ state: "active", lastFetchedOn: now - 60_000, createdOn: now - 120_000 }],
      }) as never,
      state,
      pollStaleSeconds: 30,
      nowMs: () => now,
    });
    expect(result).toEqual({ ready: false, reason: "polling_stale" });
  });

  it("fails when Postgres is unreachable", async () => {
    const state: WorkerReadinessState = { consumersRegistered: true };
    const result = await evaluateWorkerReadiness({
      pool: makePool(false) as never,
      boss: makeBoss({
        wip: [{ state: "active", lastFetchedOn: now, createdOn: now }],
      }) as never,
      state,
      pollStaleSeconds: 30,
      nowMs: () => now,
    });
    expect(result).toEqual({ ready: false, reason: "postgres_unreachable" });
  });

  it("fails when pg-boss is unreachable", async () => {
    const state: WorkerReadinessState = { consumersRegistered: true };
    const result = await evaluateWorkerReadiness({
      pool: makePool() as never,
      boss: makeBoss({
        wip: [{ state: "active", lastFetchedOn: now, createdOn: now }],
        getQueue: async () => {
          throw new Error("boss down");
        },
      }) as never,
      state,
      pollStaleSeconds: 30,
      nowMs: () => now,
    });
    expect(result).toEqual({ ready: false, reason: "pg_boss_unreachable" });
  });
});
