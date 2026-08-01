import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import { cancelActiveReviewsForResource } from "../src/agentWork/autoWorkEnqueue.js";
import { applyAutomatedPullRequestIntake } from "../src/agentWork/intake/applier.js";
import { makeTestConfig } from "./helpers/config.js";
import { createOperationLogger } from "../src/evlog.js";
import * as postgres from "../src/db/postgres.js";
import { REVIEW_QUEUE } from "../src/settings/index.js";

const intakeCfg = makeTestConfig();

function makeHeaders(delivery = "d-merge") {
  return {
    event: "pull_request",
    delivery,
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

describe("cancelActiveReviewsForResource", () => {
  it("cancels queued reviews and requests cancel on running reviews", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("status = 'queued'")) {
        return { rows: [{ id: "queued-auto" }, { id: "queued-slash" }] };
      }
      if (sql.includes("status = 'running'")) {
        return { rows: [{ id: "running-1" }] };
      }
      throw new Error(`unexpected sql: ${sql}`);
    });
    const client = { query } as unknown as PoolClient;

    const ids = await cancelActiveReviewsForResource(client, "acme/app#7");

    expect(ids).toEqual(["queued-auto", "queued-slash", "running-1"]);
    expect(query).toHaveBeenCalledTimes(2);
    const queuedSql = String(query.mock.calls[0]?.[0]);
    const runningSql = String(query.mock.calls[1]?.[0]);
    expect(queuedSql).toContain("type = 'review'");
    expect(queuedSql).not.toContain("source = 'auto'");
    expect(runningSql).toContain("cancel_requested_at");
    expect(runningSql).not.toContain("source = 'auto'");
  });
});

describe("applyAutomatedPullRequestIntake merge cancel", () => {
  it("cancels active review jobs when the PR is merged", async () => {
    const poolQuery = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO webhook_events")) {
        return { rows: [{ id: "event-merged" }] };
      }
      throw new Error(`unexpected pool query: ${sql.slice(0, 120)}`);
    });
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO webhook_events")) {
        return { rows: [{ id: "event-merged" }] };
      }
      if (sql.includes("status = 'queued'")) {
        return { rows: [{ id: "wi-queued" }] };
      }
      if (sql.includes("status = 'running'")) {
        return { rows: [{ id: "wi-running" }] };
      }
      throw new Error(`unexpected client query: ${sql.slice(0, 120)}`);
    });
    const findJobs = vi.fn(async () => [
      { id: "job-queued", state: "created", data: { workItemId: "wi-queued" } },
      { id: "job-running", state: "active", data: { workItemId: "wi-running" } },
      { id: "job-other", state: "created", data: { workItemId: "wi-other" } },
    ]);
    const cancel = vi.fn(async () => ({ rows: [] }));
    const deleteJob = vi.fn(async () => ({ rows: [] }));
    const boss = { findJobs, cancel, deleteJob, send: vi.fn() } as unknown as PgBoss;
    const pool = { query: poolQuery } as unknown as Pool;
    const txSpy = vi.spyOn(postgres, "inTransaction").mockImplementation(async (_pool, fn) =>
      fn({ query: clientQuery } as unknown as PoolClient),
    );
    const intakeLog = createOperationLogger({ method: "POST", path: "/webhooks" });

    try {
      await applyAutomatedPullRequestIntake(
        boss,
        pool,
        makeHeaders(),
        makePrRef(),
        "closed",
        intakeLog,
        intakeCfg,
        undefined,
        true,
      );

      expect(txSpy).toHaveBeenCalled();
      expect(clientQuery).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO webhook_events"),
        expect.arrayContaining(["review_cancelled_pr_merged"]),
      );
      expect(findJobs).toHaveBeenCalledWith(REVIEW_QUEUE, expect.objectContaining({ key: "acme/app#7:review" }));
      expect(cancel).toHaveBeenCalledWith(REVIEW_QUEUE, "job-queued", expect.anything());
      expect(cancel).toHaveBeenCalledWith(REVIEW_QUEUE, "job-running", expect.anything());
      expect(cancel).not.toHaveBeenCalledWith(REVIEW_QUEUE, "job-other", expect.anything());
      expect(boss.send).not.toHaveBeenCalled();
    } finally {
      txSpy.mockRestore();
    }
  });

  it("ignores close-without-merge without cancelling reviews", async () => {
    const poolQuery = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO webhook_events")) {
        return { rows: [{ id: "event-closed" }] };
      }
      throw new Error(`unexpected pool query: ${sql.slice(0, 120)}`);
    });
    const findJobs = vi.fn(async () => []);
    const boss = { findJobs, cancel: vi.fn(), send: vi.fn() } as unknown as PgBoss;
    const pool = { query: poolQuery } as unknown as Pool;
    const txSpy = vi.spyOn(postgres, "inTransaction");
    const intakeLog = createOperationLogger({ method: "POST", path: "/webhooks" });

    try {
      await applyAutomatedPullRequestIntake(
        boss,
        pool,
        makeHeaders("d-closed"),
        makePrRef(),
        "closed",
        intakeLog,
        intakeCfg,
        undefined,
        false,
      );

      expect(txSpy).not.toHaveBeenCalled();
      expect(poolQuery).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO webhook_events"), [
        expect.any(String),
        "delivery:d-closed",
        "d-closed",
        "pull_request",
        expect.any(String),
        "ignored_pull_request_closed",
      ]);
      expect(findJobs).not.toHaveBeenCalled();
      expect(boss.send).not.toHaveBeenCalled();
    } finally {
      txSpy.mockRestore();
    }
  });
});
