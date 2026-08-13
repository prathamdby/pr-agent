import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { createOperationLogger } from "../src/evlog.js";
import { makeAgentWorkScheduler } from "../src/agentWork/scheduler.js";
import {
  ACK_QUEUE,
  DESCRIPTION_QUEUE,
  REVIEW_QUEUE,
  VERIFICATION_QUEUE,
} from "../src/settings/index.js";
import * as postgres from "../src/db/postgres.js";
import { makeTestConfig } from "./helpers/config.js";
import { createJobQueue } from "./helpers/recordingBoss.js";
import { createQueryClient, createQueryPool, createUnusedPool } from "./helpers/fakePool.js";

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
  return createQueryClient(
    vi.fn(async (sql: string) => {
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
  );
}

function makeBoss(sentQueues: string[]) {
  const send = vi.fn(async (queue: string) => {
    sentQueues.push(queue);
    return "job-1";
  });
  return createJobQueue({
    send,
    findJobs: vi.fn(async () => []),
    deleteJob: vi.fn(async () => ({})),
    cancel: vi.fn(async () => ({})),
  });
}

describe("makeAgentWorkScheduler automated describe", () => {
  it("enqueues description only on pull_request opened", async () => {
    const sentQueues: string[] = [];
    const boss = makeBoss(sentQueues);

    const client = mockAutomatedClient();
    const pool = createUnusedPool();
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

  it("does not enqueue review or description on synchronize with default actions", async () => {
    const sentQueues: string[] = [];
    const boss = makeBoss(sentQueues);

    const query = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO webhook_events")) {
        return { rows: [{ id: "event-1" }] };
      }
      throw new Error(`unexpected query: ${sql.slice(0, 120)}`);
    });
    const pool = createQueryPool(query);
    const txSpy = vi.spyOn(postgres, "inTransaction").mockImplementation(async () => {
      throw new Error("inTransaction should not run for a no-work synchronize intake");
    });

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

      expect(sentQueues).not.toContain(REVIEW_QUEUE);
      expect(sentQueues).not.toContain(ACK_QUEUE);
      expect(sentQueues).not.toContain(DESCRIPTION_QUEUE);
      expect(boss.send).not.toHaveBeenCalled();
    } finally {
      txSpy.mockRestore();
    }
  });

  it("enqueues verification on synchronize with default verification actions", async () => {
    const sentQueues: string[] = [];
    const boss = makeBoss(sentQueues);

    const client = mockAutomatedClient();
    const pool = createUnusedPool();
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
    const pool = createUnusedPool();
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
