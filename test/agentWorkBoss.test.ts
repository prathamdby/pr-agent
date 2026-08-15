import { describe, expect, it, vi } from "vitest";
import type { PgBoss } from "pg-boss";

vi.mock("../src/evlog.js", () => ({
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { logError } from "../src/evlog.js";
import { bossConstructorOptions, ensureAgentQueues } from "../src/agentWork/boss.js";
import {
  ACK_DEAD_LETTER_QUEUE,
  ACK_QUEUE,
  ASK_DEAD_LETTER_QUEUE,
  ASK_QUEUE,
  CI_REFRESH_DEAD_LETTER_QUEUE,
  CI_REFRESH_QUEUE,
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

describe("ensureAgentQueues", () => {
  it("creates all DLQs concurrently before starting any parent queue", async () => {
    const deadLetterQueues = [
      ACK_DEAD_LETTER_QUEUE,
      REVIEW_DEAD_LETTER_QUEUE,
      ASK_DEAD_LETTER_QUEUE,
      DESCRIPTION_DEAD_LETTER_QUEUE,
      TRIAGE_DEAD_LETTER_QUEUE,
      VERIFICATION_DEAD_LETTER_QUEUE,
      CI_REFRESH_DEAD_LETTER_QUEUE,
    ];
    const parentQueues = [
      ACK_QUEUE,
      REVIEW_QUEUE,
      ASK_QUEUE,
      DESCRIPTION_QUEUE,
      TRIAGE_QUEUE,
      VERIFICATION_QUEUE,
      CI_REFRESH_QUEUE,
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
        deadLetter: CI_REFRESH_DEAD_LETTER_QUEUE,
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
    } as unknown as PgBoss;

    await ensureAgentQueues(boss, makeTestConfig());

    expect(vi.mocked(logError)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logError)).toHaveBeenCalledWith("agent_queue_policy_mismatch", {
      queue: REVIEW_QUEUE,
      policy: "key_strict_fifo",
    });
  });
});
