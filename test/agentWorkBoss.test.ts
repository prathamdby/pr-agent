import { describe, expect, it, vi } from "vitest";
import type { PgBoss } from "pg-boss";

const pgBossHarness = vi.hoisted(() => ({
  start: vi.fn(async () => undefined),
  stop: vi.fn(
    async (_options?: { close?: boolean; graceful?: boolean; timeout?: number }) => undefined,
  ),
}));

vi.mock("pg-boss", () => ({
  PgBoss: class {
    on(): void {}
    start(): Promise<void> {
      return pgBossHarness.start();
    }
    stop(options?: { close?: boolean; graceful?: boolean; timeout?: number }): Promise<void> {
      return pgBossHarness.stop(options);
    }
  },
}));

vi.mock("../src/evlog.ts", () => ({
  logDebug: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { logError, logWarn } from "../src/evlog.ts";
import {
  bossConstructorOptions,
  createPgBossEventGate,
  createStartedBoss,
  ensureAgentQueues,
  retireCodeIndexBuildQueue,
  retireLeftoverCiRefreshQueues,
} from "../src/agentWork/boss.ts";
import {
  ACK_DEAD_LETTER_QUEUE,
  ACK_QUEUE,
  ASK_DEAD_LETTER_QUEUE,
  ASK_QUEUE,
  CI_PROJECTION_DEAD_LETTER_QUEUE,
  CI_PROJECTION_QUEUE,
  DESCRIPTION_DEAD_LETTER_QUEUE,
  DESCRIPTION_QUEUE,
  REVIEW_DEAD_LETTER_QUEUE,
  REVIEW_QUEUE,
  TRIAGE_DEAD_LETTER_QUEUE,
  TRIAGE_QUEUE,
  VERIFICATION_DEAD_LETTER_QUEUE,
  VERIFICATION_QUEUE,
} from "../src/settings/index.ts";
import { makeTestConfig } from "./helpers/config.ts";

describe("bossConstructorOptions", () => {
  it("keeps pg-boss maintenance on the worker role", () => {
    expect(
      bossConstructorOptions(
        makeTestConfig({ runtime: { databaseUrl: "postgres://test", role: "worker" } }),
      ),
    ).toMatchObject({
      schedule: true,
      supervise: true,
      max: 8,
    });
  });

  it("disables pg-boss maintenance on the web role", () => {
    expect(
      bossConstructorOptions(
        makeTestConfig({ runtime: { databaseUrl: "postgres://test", role: "web" } }),
      ),
    ).toMatchObject({
      schedule: false,
      supervise: false,
      max: 4,
    });
  });
});

describe("createPgBossEventGate", () => {
  it("reports the first occurrence per key and counts repeats until the window rolls", () => {
    const gate = createPgBossEventGate(60_000);

    expect(gate("ECONNRESET", 0)).toBe(0);
    expect(gate("ECONNRESET", 1_000)).toBeNull();
    expect(gate("ECONNRESET", 59_000)).toBeNull();
    expect(gate("other", 59_000)).toBe(0);

    expect(gate("ECONNRESET", 60_000)).toBe(2);
    expect(gate("ECONNRESET", 61_000)).toBeNull();
    expect(gate("ECONNRESET", 120_000)).toBe(1);
  });
});

describe("ensureAgentQueues", () => {
  it("creates all DLQs concurrently before starting any parent queue", async () => {
    const deadLetterQueues = [
      ACK_DEAD_LETTER_QUEUE,
      REVIEW_DEAD_LETTER_QUEUE,
      ASK_DEAD_LETTER_QUEUE,
      DESCRIPTION_DEAD_LETTER_QUEUE,
      TRIAGE_DEAD_LETTER_QUEUE,
      VERIFICATION_DEAD_LETTER_QUEUE,
      CI_PROJECTION_DEAD_LETTER_QUEUE,
    ];
    const parentQueues = [
      ACK_QUEUE,
      REVIEW_QUEUE,
      ASK_QUEUE,
      DESCRIPTION_QUEUE,
      TRIAGE_QUEUE,
      VERIFICATION_QUEUE,
      CI_PROJECTION_QUEUE,
    ];

    type Deferred = {
      readonly name: string;
      readonly options: unknown;
      readonly resolve: () => void;
    };
    const started: Deferred[] = [];
    const createQueue = vi.fn((name: string, options: unknown) => {
      let resolve!: () => void;
      const promise = new Promise<void>((res) => {
        resolve = res;
      });
      started.push({ name, options, resolve });
      return promise;
    });
    const boss = {
      createQueue,
      getQueue: vi.fn(async () => ({ policy: "standard" })),
      getQueueStats: vi.fn(async () => [{ queuedCount: 0, activeCount: 0, deferredCount: 0 }]),
      deleteQueue: vi.fn(async () => undefined),
      getDb: () => ({ executeSql: vi.fn(async () => ({ rows: [] })) }),
    } as unknown as PgBoss;
    const cfg = makeTestConfig();

    const ensurePromise = ensureAgentQueues(boss, cfg);

    await vi.waitFor(() => expect(started).toHaveLength(deadLetterQueues.length));
    expect(started.map((entry) => entry.name)).toEqual(deadLetterQueues);
    expect(started.some((entry) => parentQueues.includes(entry.name))).toBe(false);

    for (const entry of started) {
      entry.resolve();
    }

    await vi.waitFor(() =>
      expect(started).toHaveLength(deadLetterQueues.length + parentQueues.length),
    );
    const parentStarted = started.slice(deadLetterQueues.length);
    expect(parentStarted.map((entry) => entry.name)).toEqual(parentQueues);
    expect(parentStarted.map((entry) => entry.options)).toEqual([
      expect.objectContaining({ policy: "standard", deadLetter: ACK_DEAD_LETTER_QUEUE }),
      expect.objectContaining({ policy: "standard", deadLetter: REVIEW_DEAD_LETTER_QUEUE }),
      expect.objectContaining({ policy: "standard", deadLetter: ASK_DEAD_LETTER_QUEUE }),
      expect.objectContaining({
        policy: "standard",
        deadLetter: DESCRIPTION_DEAD_LETTER_QUEUE,
      }),
      expect.objectContaining({ policy: "standard", deadLetter: TRIAGE_DEAD_LETTER_QUEUE }),
      expect.objectContaining({
        policy: "standard",
        deadLetter: VERIFICATION_DEAD_LETTER_QUEUE,
      }),
      expect.objectContaining({
        policy: "standard",
        deadLetter: CI_PROJECTION_DEAD_LETTER_QUEUE,
      }),
    ]);

    for (const entry of parentStarted) {
      entry.resolve();
    }

    await ensurePromise;
    expect(started).toHaveLength(deadLetterQueues.length + parentQueues.length);
  });

  it("logs an error when a leased queue kept a non-standard policy", async () => {
    const createQueue = vi.fn(async () => undefined);
    const policies: Record<string, string> = {
      [REVIEW_QUEUE]: "key_strict_fifo",
      [DESCRIPTION_QUEUE]: "standard",
      [TRIAGE_QUEUE]: "standard",
      [VERIFICATION_QUEUE]: "standard",
    };
    const boss = {
      createQueue,
      getQueue: vi.fn(async (name: string) => ({ policy: policies[name] ?? "standard" })),
      getQueueStats: vi.fn(async () => [{ queuedCount: 0, activeCount: 0, deferredCount: 0 }]),
      deleteQueue: vi.fn(async () => undefined),
      getDb: () => ({ executeSql: vi.fn(async () => ({ rows: [] })) }),
    } as unknown as PgBoss;

    await ensureAgentQueues(boss, makeTestConfig());

    expect(vi.mocked(logError)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logError)).toHaveBeenCalledWith("agent_queue_policy_mismatch", {
      queue: REVIEW_QUEUE,
      policy: "key_strict_fifo",
    });
  });

  function bossWithJobIndex(executeSql: (sql: string) => Promise<{ rows: [] }>): PgBoss {
    return {
      createQueue: vi.fn(async () => undefined),
      getQueue: vi.fn(async () => ({ policy: "standard" })),
      getQueueStats: vi.fn(async () => [{ queuedCount: 0, activeCount: 0, deferredCount: 0 }]),
      deleteQueue: vi.fn(async () => undefined),
      getDb: () => ({ executeSql }),
    } as unknown as PgBoss;
  }

  it("rejects queue startup when job index creation is denied", async () => {
    const denied = Object.assign(new Error("permission denied for schema pgboss"), {
      code: "42501",
    });
    const executeSql = vi.fn(async () => {
      throw denied;
    });

    await expect(ensureAgentQueues(bossWithJobIndex(executeSql), makeTestConfig())).rejects.toBe(
      denied,
    );
    expect(executeSql).toHaveBeenCalledTimes(1);
    expect(executeSql.mock.calls[0]?.[0]).toEqual(
      expect.stringContaining("job_name_singleton_key_idx"),
    );
  });

  it("continues queue startup when the job index already exists", async () => {
    const executeSql = vi.fn(async () => {
      throw Object.assign(new Error("relation already exists"), { code: "42P07" });
    });

    await expect(
      ensureAgentQueues(bossWithJobIndex(executeSql), makeTestConfig()),
    ).resolves.toBeUndefined();
    expect(executeSql).toHaveBeenCalledTimes(1);
    expect(executeSql.mock.calls[0]?.[0]).toEqual(
      expect.stringContaining("job_name_singleton_key_idx"),
    );
  });
});

describe("retireCodeIndexBuildQueue", () => {
  it("deletes the retired code-index queue even when it still has jobs", async () => {
    const deleteQueue = vi.fn(async () => undefined);
    const boss = {
      getQueue: vi.fn(async (name: string) => ({ name })),
      getQueueStats: vi.fn(async () => [{ queuedCount: 3, activeCount: 1, deferredCount: 0 }]),
      deleteQueue,
    } as unknown as PgBoss;

    await retireCodeIndexBuildQueue(boss);

    expect(deleteQueue).toHaveBeenCalledWith("code-index-build");
  });
});

describe("retireLeftoverCiRefreshQueues", () => {
  it("deletes empty retired refresh queues", async () => {
    const deleteQueue = vi.fn(async () => undefined);
    const boss = {
      getQueue: vi.fn(async () => ({ name: "present" })),
      getQueueStats: vi.fn(async () => [{ queuedCount: 0, activeCount: 0, deferredCount: 0 }]),
      deleteQueue,
    } as unknown as PgBoss;

    await retireLeftoverCiRefreshQueues(boss);

    expect(deleteQueue).toHaveBeenCalledWith("agent-work-ci-refresh");
    expect(deleteQueue).toHaveBeenCalledWith("agent-work-ci-refresh-dead");
  });

  it("leaves a retired queue with live jobs in place", async () => {
    const deleteQueue = vi.fn(async () => undefined);
    const boss = {
      getQueue: vi.fn(async (name: string) => (name === "agent-work-ci-refresh" ? { name } : null)),
      getQueueStats: vi.fn(async () => [{ queuedCount: 2, activeCount: 0, deferredCount: 0 }]),
      deleteQueue,
    } as unknown as PgBoss;

    await retireLeftoverCiRefreshQueues(boss);

    expect(deleteQueue).not.toHaveBeenCalled();
    expect(vi.mocked(logWarn)).toHaveBeenCalledWith("retired_queue_not_empty", {
      queue: "agent-work-ci-refresh",
      liveCount: 2,
    });
  });
});

describe("createStartedBoss", () => {
  it("stops the instance and rethrows when start fails", async () => {
    const startError = Object.assign(new Error("connect ENOTFOUND"), { code: "ENOTFOUND" });
    pgBossHarness.start.mockRejectedValueOnce(startError);
    pgBossHarness.stop.mockResolvedValueOnce(undefined);

    await expect(
      createStartedBoss(makeTestConfig({ runtime: { databaseUrl: "postgres://test" } })),
    ).rejects.toBe(startError);
    expect(pgBossHarness.stop).toHaveBeenCalledWith({
      close: true,
      graceful: false,
      timeout: 1_000,
    });
  });

  it("rethrows the start error when stop also fails", async () => {
    const startError = Object.assign(new Error("connect ENOTFOUND"), { code: "ENOTFOUND" });
    pgBossHarness.start.mockRejectedValueOnce(startError);
    pgBossHarness.stop.mockRejectedValueOnce(new Error("stop failed"));

    await expect(
      createStartedBoss(makeTestConfig({ runtime: { databaseUrl: "postgres://test" } })),
    ).rejects.toBe(startError);
  });
});
