import { describe, expect, it, vi } from "vitest";
import { makeTestConfig } from "./helpers/config.js";
const intakeCfg = makeTestConfig();
import { Effect } from "effect";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { createOperationLogger } from "../src/evlog.js";
import { makeAgentWorkScheduler } from "../src/agentWork/scheduler.js";
import * as postgres from "../src/db/postgres.js";

function makeHeaders(event = "ping") {
  return {
    event,
    delivery: `d-${event}`,
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

function makePool() {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("INSERT INTO webhook_events")) {
      return { rows: [{ id: "event-1" }] };
    }
    throw new Error(`unexpected query: ${sql.slice(0, 120)}`);
  });
  return {
    pool: {
      query,
    } as unknown as Pool,
    query,
  };
}

describe("makeAgentWorkScheduler ignored intake", () => {
  it("records ignored events with a direct pool insert", async () => {
    const { pool, query } = makePool();
    const boss = { send: vi.fn() } as unknown as PgBoss;
    const txSpy = vi.spyOn(postgres, "inTransaction");
    const scheduler = makeAgentWorkScheduler(pool, boss, intakeCfg);
    const intakeLog = createOperationLogger({ method: "POST", path: "/webhooks" });

    try {
      await Effect.runPromise(
        scheduler.recordIgnored(makeHeaders(), "ignored_event_ping", intakeLog),
      );

      expect(txSpy).not.toHaveBeenCalled();
      expect(query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO webhook_events"), [
        expect.any(String),
        "delivery:d-ping",
        "d-ping",
        "ping",
        expect.any(String),
        "ignored_event_ping",
      ]);
      expect(boss.send).not.toHaveBeenCalled();
    } finally {
      txSpy.mockRestore();
    }
  });

  it("records ignored pull request actions without a transaction", async () => {
    const { pool, query } = makePool();
    const boss = { send: vi.fn() } as unknown as PgBoss;
    const txSpy = vi.spyOn(postgres, "inTransaction");
    const scheduler = makeAgentWorkScheduler(pool, boss, intakeCfg);
    const intakeLog = createOperationLogger({ method: "POST", path: "/webhooks" });

    try {
      await Effect.runPromise(
        scheduler.submitAutomatedReview(
          makeHeaders("pull_request"),
          makePrRef(),
          "labeled",
          intakeLog,
        ),
      );

      expect(txSpy).not.toHaveBeenCalled();
      expect(query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO webhook_events"), [
        expect.any(String),
        "delivery:d-pull_request",
        "d-pull_request",
        "pull_request",
        expect.any(String),
        "ignored_pull_request_labeled",
      ]);
      expect(boss.send).not.toHaveBeenCalled();
    } finally {
      txSpy.mockRestore();
    }
  });
});
