import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import type { Pool, PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import { createOperationLogger } from "../src/evlog.js";
import { makeAgentWorkScheduler } from "../src/agentWork/scheduler.js";
import { ACK_QUEUE, DESCRIPTION_QUEUE, REVIEW_QUEUE } from "../src/settings/index.js";
import * as postgres from "../src/db/postgres.js";

function makeAutomatedHeaders() {
  return { event: "pull_request", delivery: "d-auto", rawBody: Buffer.from("{}") };
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
      throw new Error(`unexpected query: ${sql.slice(0, 120)}`);
    }),
  } as unknown as PoolClient;
}

describe("makeAgentWorkScheduler automated describe", () => {
  it("enqueues description only on pull_request opened", async () => {
    const sentQueues: string[] = [];
    const boss = {
      send: vi.fn(async (queue: string) => {
        sentQueues.push(queue);
        return "job-1";
      }),
    } as unknown as PgBoss;

    const client = mockAutomatedClient();
    const pool = {} as Pool;
    vi.spyOn(postgres, "inTransaction").mockImplementation(async (_pool, fn) => fn(client));

    const scheduler = makeAgentWorkScheduler(pool, boss);
    const intakeLog = createOperationLogger({ method: "POST", path: "/webhooks" });

    await Effect.runPromise(
      scheduler.submitAutomatedReview(makeAutomatedHeaders(), makePrRef(), "opened", intakeLog),
    );

    expect(sentQueues).toContain(REVIEW_QUEUE);
    expect(sentQueues).toContain(ACK_QUEUE);
    expect(sentQueues).toContain(DESCRIPTION_QUEUE);
  });

  it("does not enqueue description on synchronize", async () => {
    const sentQueues: string[] = [];
    const boss = {
      send: vi.fn(async (queue: string) => {
        sentQueues.push(queue);
        return "job-1";
      }),
    } as unknown as PgBoss;

    const client = mockAutomatedClient();
    const pool = {} as Pool;
    vi.spyOn(postgres, "inTransaction").mockImplementation(async (_pool, fn) => fn(client));

    const scheduler = makeAgentWorkScheduler(pool, boss);
    const intakeLog = createOperationLogger({ method: "POST", path: "/webhooks" });

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
    expect(sentQueues).not.toContain(DESCRIPTION_QUEUE);
  });
});
