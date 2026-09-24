import { describe, expect, it, vi } from "vitest";
import type { PgBoss } from "pg-boss";

vi.mock("../src/evlog.js", () => ({
  logDebug: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { logError, logWarn } from "../src/evlog.js";
import {
  bossConstructorOptions,
  createPgBossEventGate,
  ensureAgentQueues,
  retireLeftoverCiRefreshQueues,
} from "../src/agentWork/boss.js";
import {
  ACK_DEAD_LETTER_QUEUE,
  ACK_QUEUE,
  ASK_DEAD_LETTER_QUEUE,
  ASK_QUEUE,
  CI_PROJECTION_DEAD_LETTER_QUEUE,
  CI_PROJECTION_QUEUE,
  CODE_INDEX_BUILD_QUEUE,
  DESCRIPTION_DEAD_LETTER_QUEUE,
  DESCRIPTION_QUEUE,
  REVIEW_DEAD_LETTER_QUEUE,
  REVIEW_QUEUE,
  TRIAGE_DEAD_LETTER_QUEUE,
  TRIAGE_QUEUE,
  VERIFICATION_DEAD_LETTER_QUEUE,
  VERIFICATION_QUEUE,
} from "../src/settings/index.js";
import { makeTestConfig } from "./helpers/config.js";

describe("bossConstructorOptions", () => {
  it("keeps pg-boss maintenance on the worker role", () => {
    expect(
      bossConstructorOptions({ databaseUrl: "postgres://test", role: "worker" }),
    ).toMatchObject({
      schedule: true,
      supervise: true,
      max: 8,
    });
  });

  it("disables pg-boss maintenance on the web role", () => {
    expect(bossConstructorOptions({ databaseUrl: "postgres://test", role: "web" })).toMatchObject({
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

    await vi.waitFor(() =>
      expect(started).toHaveLength(deadLetterQueues.length + parentQueues.length + 1),
    );
    const codeIndexStarted = started[deadLetterQueues.length + parentQueues.length]!;
    expect(codeIndexStarted.name).toBe(CODE_INDEX_BUILD_QUEUE);
    expect(codeIndexStarted.options).toEqual(expect.objectContaining({ policy: "standard" }));
    expect(codeIndexStarted.options).not.toHaveProperty("deadLetter");
    codeIndexStarted.resolve();

    await ensurePromise;
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
    } as unknown as PgBoss;

    await ensureAgentQueues(boss, makeTestConfig());

    expect(vi.mocked(logError)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logError)).toHaveBeenCalledWith("agent_queue_policy_mismatch", {
      queue: REVIEW_QUEUE,
      policy: "key_strict_fifo",
    });
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
