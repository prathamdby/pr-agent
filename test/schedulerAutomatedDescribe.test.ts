import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import type { Pool, PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import { createOperationLogger } from "../src/evlog.js";
import { makeAgentWorkScheduler } from "../src/agentWork/scheduler.js";
import {
  ACK_QUEUE,
  DEFERRED_HEAD_SHA,
  DESCRIPTION_QUEUE,
  REVIEW_QUEUE,
  VERIFICATION_QUEUE,
} from "../src/settings/index.js";
import * as postgres from "../src/db/postgres.js";
import { makeTestConfig } from "./helpers/config.js";

const intakeCfg = makeTestConfig();

function makeAutomatedHeaders() {
  return {
    event: "pull_request",
    delivery: "d-auto",
    rawBody: Buffer.from("{}"),
  };
}

function makePrRef() {
  return {
    owner: "acme",
    repo: "app",
    prNumber: 7,
    installationId: 42,
    headSha: "abc123",
  };
}

function mockAutomatedClient() {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO webhook_event_replays")) {
        return { rows: [{ body_sha256: "hash" }] };
      }
      if (sql.includes("INSERT INTO webhook_events")) {
        return { rows: [{ id: "event-1" }] };
      }
      if (sql.includes("UPDATE agent_work_items")) {
        return { rows: [] };
      }
      if (
        sql.includes("INSERT INTO agent_work_items") ||
        sql.includes("INSERT INTO publish_records")
      ) {
        return { rows: [] };
      }
      if (sql.includes("pg_advisory_xact_lock")) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql.slice(0, 120)}`);
    }),
  } as unknown as PoolClient;
}

function makeBoss(sentQueues: string[]): PgBoss {
  return {
    send: vi.fn(async (queue: string) => {
      sentQueues.push(queue);
      return "job-1";
    }),
    findJobs: vi.fn(async () => []),
    deleteJob: vi.fn(async () => ({ rows: [] })),
    cancel: vi.fn(async () => ({ rows: [] })),
  } as unknown as PgBoss;
}

describe("makeAgentWorkScheduler automated describe", () => {
  it("enqueues description only on pull_request opened", async () => {
    const sentQueues: string[] = [];
    const boss = makeBoss(sentQueues);

    const client = mockAutomatedClient();
    const pool = {} as Pool;
    vi.spyOn(postgres, "inTransaction").mockImplementation(async (_pool, fn) => fn(client));

    const scheduler = makeAgentWorkScheduler(pool, boss, intakeCfg);
    const intakeLog = createOperationLogger({
      method: "POST",
      path: "/webhooks",
    });

    await Effect.runPromise(
      scheduler.submitAutomatedReview(makeAutomatedHeaders(), makePrRef(), "opened", intakeLog),
    );

    expect(sentQueues).toContain(REVIEW_QUEUE);
    expect(sentQueues).toContain(ACK_QUEUE);
    expect(sentQueues).toContain(DESCRIPTION_QUEUE);
  });

  it("does not enqueue a replacement review on synchronize when no review is active", async () => {
    const sentQueues: string[] = [];
    const boss = makeBoss(sentQueues);

    // synchronize never starts a review, so with no queued/running auto review the
    // push supersede finds nothing to replace and intake enqueues nothing.
    // Verification is also disabled here to keep the test focused on review.
    const query = vi.fn(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO webhook_event_replays")) {
        return { rows: [{ body_sha256: "hash" }] };
      }
      if (sql.includes("INSERT INTO webhook_events")) {
        return { rows: [{ id: "event-1" }] };
      }
      if (sql.includes("UPDATE agent_work_items")) {
        return { rows: [] };
      }
      if (sql.includes("pg_advisory_xact_lock")) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql.slice(0, 120)}`);
    });
    const pool = {
      query,
      connect: vi.fn(async () => ({ query, release: vi.fn() })),
    } as unknown as Pool;
    const txSpy = vi.spyOn(postgres, "inTransaction").mockImplementation(async (_pool, fn) => {
      return fn({ query } as unknown as PoolClient);
    });
    txSpy.mockClear();

    const scheduler = makeAgentWorkScheduler(pool, boss, {
      features: { ...intakeCfg.features, verification: "off" },
    });
    const intakeLog = createOperationLogger({
      method: "POST",
      path: "/webhooks",
    });

    try {
      await Effect.runPromise(
        scheduler.submitAutomatedReview(
          makeAutomatedHeaders(),
          makePrRef(),
          "synchronize",
          intakeLog,
        ),
      );

      expect(txSpy).toHaveBeenCalledOnce();
      expect(sentQueues).not.toContain(REVIEW_QUEUE);
      expect(sentQueues).not.toContain(ACK_QUEUE);
      expect(sentQueues).not.toContain(DESCRIPTION_QUEUE);
      expect(boss.send).not.toHaveBeenCalled();
    } finally {
      txSpy.mockRestore();
    }
  });

  it("cancels an in-flight auto review on synchronize and enqueues a deferred-head replacement", async () => {
    const sentQueues: string[] = [];
    const boss = makeBoss(sentQueues);
    const workItemInserts: unknown[][] = [];

    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("INSERT INTO webhook_event_replays")) {
        return { rows: [{ body_sha256: "hash" }] };
      }
      if (sql.includes("INSERT INTO webhook_events")) {
        return { rows: [{ id: "event-1" }] };
      }
      if (sql.includes("UPDATE agent_work_items") && sql.includes("cancel_requested_at")) {
        // The running auto review gets the cooperative cancel request.
        return { rows: [{ id: "running-review-1" }], rowCount: 1 };
      }
      if (sql.includes("UPDATE agent_work_items")) {
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO agent_work_items")) {
        if (Array.isArray(params)) workItemInserts.push(params);
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO publish_records")) {
        return { rows: [] };
      }
      if (sql.includes("pg_advisory_xact_lock")) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql.slice(0, 120)}`);
    });

    const client = { query } as unknown as PoolClient;
    const pool = {} as Pool;
    vi.spyOn(postgres, "inTransaction").mockImplementation(async (_pool, fn) => fn(client));

    const scheduler = makeAgentWorkScheduler(pool, boss, intakeCfg);
    const intakeLog = createOperationLogger({
      method: "POST",
      path: "/webhooks",
    });

    await Effect.runPromise(
      scheduler.submitAutomatedReview(
        makeAutomatedHeaders(),
        makePrRef(),
        "synchronize",
        intakeLog,
      ),
    );

    expect(sentQueues).toContain(REVIEW_QUEUE);
    expect(sentQueues).toContain(ACK_QUEUE);
    expect(sentQueues).toContain(VERIFICATION_QUEUE);
    // Replacement review is created with a deferred head for claim-time resolution.
    const replacementInsert = workItemInserts.find((params) => params[2] === "review");
    expect(replacementInsert?.[8]).toBe(DEFERRED_HEAD_SHA);
  });

  it("enqueues verification on synchronize with default verification actions", async () => {
    const sentQueues: string[] = [];
    const boss = makeBoss(sentQueues);

    const client = mockAutomatedClient();
    const pool = {} as Pool;
    vi.spyOn(postgres, "inTransaction").mockImplementation(async (_pool, fn) => fn(client));

    const scheduler = makeAgentWorkScheduler(pool, boss, intakeCfg);
    const intakeLog = createOperationLogger({
      method: "POST",
      path: "/webhooks",
    });

    await Effect.runPromise(
      scheduler.submitAutomatedReview(
        makeAutomatedHeaders(),
        makePrRef(),
        "synchronize",
        intakeLog,
      ),
    );

    expect(sentQueues).toContain(VERIFICATION_QUEUE);
    expect(sentQueues).not.toContain(REVIEW_QUEUE);
    expect(sentQueues).not.toContain(DESCRIPTION_QUEUE);
  });

  it("skips description on opened when FEATURE_DESCRIBE is manual", async () => {
    const sentQueues: string[] = [];
    const boss = makeBoss(sentQueues);

    const client = mockAutomatedClient();
    const pool = {} as Pool;
    vi.spyOn(postgres, "inTransaction").mockImplementation(async (_pool, fn) => fn(client));

    const scheduler = makeAgentWorkScheduler(pool, boss, {
      features: { ...intakeCfg.features, describe: "manual" },
    });
    const intakeLog = createOperationLogger({
      method: "POST",
      path: "/webhooks",
    });

    await Effect.runPromise(
      scheduler.submitAutomatedReview(makeAutomatedHeaders(), makePrRef(), "opened", intakeLog),
    );

    expect(sentQueues).toContain(REVIEW_QUEUE);
    expect(sentQueues).not.toContain(DESCRIPTION_QUEUE);
  });
});
