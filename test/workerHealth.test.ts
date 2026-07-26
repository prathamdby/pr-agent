import { afterEach, describe, expect, it, vi } from "vitest";
import type { PgBoss } from "pg-boss";
import {
  collectQueueDiagnostics,
  evaluateWorkerReadiness,
  probeWorkerDependencies,
  startPeriodicQueueDiagnostics,
  WORKER_CONSUMER_QUEUES,
} from "../src/agentWork/workerHealth.js";
import { REVIEW_QUEUE } from "../src/settings/index.js";
import * as evlog from "../src/evlog.js";

describe("evaluateWorkerReadiness", () => {
  it("is ready when consumers are registered and dependencies respond", () => {
    const snapshot = evaluateWorkerReadiness({
      registeredQueues: new Set(WORKER_CONSUMER_QUEUES),
      postgresOk: true,
      pgBossInstalled: true,
    });
    expect(snapshot).toEqual({ ready: true, reasons: [], missingQueues: [] });
  });

  it("fails when consumers are missing even if postgres is up", () => {
    const snapshot = evaluateWorkerReadiness({
      registeredQueues: new Set([REVIEW_QUEUE]),
      postgresOk: true,
      pgBossInstalled: true,
    });
    expect(snapshot.ready).toBe(false);
    expect(snapshot.reasons).toContain("consumers_not_registered");
    expect(snapshot.missingQueues).toContain("agent-work-ack");
  });

  it("fails when postgres or pg-boss is down", () => {
    expect(
      evaluateWorkerReadiness({
        registeredQueues: new Set(WORKER_CONSUMER_QUEUES),
        postgresOk: false,
        pgBossInstalled: true,
      }).reasons,
    ).toContain("postgres_unreachable");
    expect(
      evaluateWorkerReadiness({
        registeredQueues: new Set(WORKER_CONSUMER_QUEUES),
        postgresOk: true,
        pgBossInstalled: false,
      }).reasons,
    ).toContain("pg_boss_not_installed");
  });
});

describe("probeWorkerDependencies", () => {
  it("times out a hung postgres ping without sleeping the test clock", async () => {
    const timers: Array<{ ms: number; cb: () => void }> = [];
    const setTimeoutFn = ((cb: () => void, ms?: number) => {
      timers.push({ ms: ms ?? 0, cb });
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    const clearTimeoutFn = vi.fn() as unknown as typeof clearTimeout;

    const pending = probeWorkerDependencies(
      { query: () => new Promise(() => undefined) },
      { isInstalled: async () => true },
      { pingTimeoutMs: 25, setTimeoutFn, clearTimeoutFn },
    );
    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBe(25);
    timers[0]?.cb();
    await expect(pending).resolves.toEqual({ postgresOk: false, pgBossInstalled: true });
  });
});

describe("collectQueueDiagnostics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports depth, DLQ totals, blocked-key age, and oldest running work item", async () => {
    const now = new Date("2026-07-26T12:00:00.000Z");
    const getQueueStats = vi.fn(async (queue: string) => [
      {
        name: queue,
        deferredCount: 1,
        queuedCount: 2,
        readyCount: 2,
        activeCount: 3,
        failedCount: 0,
        totalCount: 5,
        capturedOn: now,
      },
    ]);
    const getBlockedKeys = vi.fn(async () => ["owner/repo#1"]);
    const findJobs = vi.fn(async () => [
      {
        createdOn: new Date("2026-07-26T11:59:00.000Z"),
      },
    ]);
    const pool = {
      query: vi.fn(async () => ({ rows: [{ age_ms: "45000" }] })),
    };

    const report = await collectQueueDiagnostics({
      boss: { getQueueStats, getBlockedKeys, findJobs } as unknown as PgBoss,
      pool,
      now,
      diagnosticQueues: [REVIEW_QUEUE],
      dlqQueues: ["agent-work-review-dead"],
    });

    expect(report.queues).toEqual([
      {
        queue: REVIEW_QUEUE,
        queued: 2,
        active: 3,
        total: 5,
        deferred: 1,
        failed: 0,
      },
    ]);
    expect(report.deadLetters).toEqual([
      { queue: "agent-work-review-dead", queued: 2, total: 5 },
    ]);
    expect(report.blockedReviewKeys).toEqual([{ key: "owner/repo#1", ageMs: 60_000 }]);
    expect(report.oldestRunningWorkItemAgeMs).toBe(45_000);
    expect(report.at).toBe(now.toISOString());
  });
});

describe("startPeriodicQueueDiagnostics", () => {
  it("fires ticks on the injected interval without real sleeps", async () => {
    const logWarn = vi.spyOn(evlog, "logWarn").mockImplementation(() => undefined);
    const callbacks: Array<() => void> = [];
    const setIntervalFn = ((cb: () => void) => {
      callbacks.push(cb);
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    const clearIntervalFn = vi.fn() as unknown as typeof clearInterval;
    const tick = vi.fn(async () => undefined);
    const now = new Date("2026-07-26T12:00:00.000Z");

    const loop = startPeriodicQueueDiagnostics({
      intervalMs: 60_000,
      now: () => now,
      tick,
      setIntervalFn,
      clearIntervalFn,
    });

    expect(callbacks).toHaveLength(1);
    callbacks[0]?.();
    await vi.waitFor(() => expect(tick).toHaveBeenCalledWith(now));
    loop.stop();
    expect(clearIntervalFn).toHaveBeenCalledWith(1);
    expect(logWarn).not.toHaveBeenCalled();
  });
});
