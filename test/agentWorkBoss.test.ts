import { describe, expect, it, vi } from "vitest";
import type { PgBoss } from "pg-boss";
import { bossConstructorOptions, ensureAgentQueues } from "../src/agentWork/boss.js";
import {
  ACK_DEAD_LETTER_QUEUE,
  ACK_QUEUE,
  ASK_DEAD_LETTER_QUEUE,
  ASK_QUEUE,
  DESCRIPTION_DEAD_LETTER_QUEUE,
  DESCRIPTION_QUEUE,
  REVIEW_DEAD_LETTER_QUEUE,
  REVIEW_QUEUE,
  THREAD_REPLY_CLASSIFY_DEAD_LETTER_QUEUE,
  THREAD_REPLY_CLASSIFY_QUEUE,
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
    });
  });

  it("disables pg-boss maintenance on the web role", () => {
    expect(bossConstructorOptions({ databaseUrl: "postgres://test", role: "web" })).toMatchObject({
      schedule: false,
      supervise: false,
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
      THREAD_REPLY_CLASSIFY_DEAD_LETTER_QUEUE,
    ];
    const parentQueues = [
      ACK_QUEUE,
      REVIEW_QUEUE,
      ASK_QUEUE,
      DESCRIPTION_QUEUE,
      TRIAGE_QUEUE,
      VERIFICATION_QUEUE,
      THREAD_REPLY_CLASSIFY_QUEUE,
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
    const boss = { createQueue } as unknown as PgBoss;
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
      expect.objectContaining({ policy: "key_strict_fifo", deadLetter: REVIEW_DEAD_LETTER_QUEUE }),
      expect.objectContaining({ policy: "standard", deadLetter: ASK_DEAD_LETTER_QUEUE }),
      expect.objectContaining({
        policy: "key_strict_fifo",
        deadLetter: DESCRIPTION_DEAD_LETTER_QUEUE,
      }),
      expect.objectContaining({ policy: "key_strict_fifo", deadLetter: TRIAGE_DEAD_LETTER_QUEUE }),
      expect.objectContaining({
        policy: "key_strict_fifo",
        deadLetter: VERIFICATION_DEAD_LETTER_QUEUE,
      }),
      expect.objectContaining({
        policy: "standard",
        deadLetter: THREAD_REPLY_CLASSIFY_DEAD_LETTER_QUEUE,
      }),
    ]);

    for (const entry of parentStarted) {
      entry.resolve();
    }
    await ensurePromise;
  });
});
