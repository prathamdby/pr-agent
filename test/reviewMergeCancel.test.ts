import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import { cancelActiveReviews } from "../src/agentWork/intake/workItemRepository.js";
import { applyAutomatedPullRequestIntake } from "../src/agentWork/intake/applier.js";
import { makeTestConfig } from "./helpers/config.js";
import { createOperationLogger } from "../src/evlog.js";
import * as postgres from "../src/db/postgres.js";
import * as evlog from "../src/evlog.js";
import { ACK_QUEUE, REVIEW_CANCELLED_PR_MERGED, REVIEW_QUEUE } from "../src/settings/index.js";

const intakeCfg = makeTestConfig();
const mergedAttribution = { kind: "merged" as const };
const mergedPatch = JSON.stringify({ cancelAttribution: mergedAttribution });

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

describe("cancelActiveReviews (merge)", () => {
  it("cancels queued and running reviews to terminal cancelled", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("status = 'queued'")) {
        return {
          rows: [
            {
              id: "queued-auto",
              source: "auto",
              head_sha: "sha-a",
              created_at: "2026-01-01T00:00:02Z",
            },
            {
              id: "queued-slash",
              source: "slash",
              head_sha: "sha-b",
              created_at: "2026-01-01T00:00:01Z",
            },
          ],
        };
      }
      if (sql.includes("status = 'running'")) {
        return {
          rows: [
            {
              id: "running-1",
              source: "auto",
              head_sha: "sha-r",
              created_at: "2026-01-01T00:00:03Z",
            },
          ],
        };
      }
      throw new Error(`unexpected sql: ${sql}`);
    });
    const client = { query } as unknown as PoolClient;

    const cancelled = await cancelActiveReviews(client, "acme/app#7", mergedAttribution);

    expect(cancelled.map((row) => row.id)).toEqual(["running-1", "queued-auto", "queued-slash"]);
    expect(query).toHaveBeenCalledTimes(2);
    const queuedSql = String(query.mock.calls[0]?.[0]);
    const runningSql = String(query.mock.calls[1]?.[0]);
    expect(queuedSql).toContain("type = 'review'");
    expect(queuedSql).not.toContain("source = 'auto'");
    expect(runningSql).toContain("cancel_requested_at");
    expect(runningSql).toMatch(/status\s*=\s*'cancelled'/);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("status = 'queued'"), [
      "acme/app#7",
      "Pull request merged",
      mergedPatch,
    ]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("status = 'running'"), [
      "acme/app#7",
      "Pull request merged",
      mergedPatch,
    ]);
  });
});

describe("applyAutomatedPullRequestIntake merge cancel", () => {
  it("cancels active review jobs and enqueues cancelProgress ack when the PR is merged", async () => {
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
      if (sql.includes("FROM agent_work_items") && sql.includes("status = ANY")) {
        // Merge cancel terminalises queued/running; only the foreign holder stays active.
        return { rows: [{ id: "wi-other" }] };
      }
      if (sql.includes("status = 'queued'")) {
        return {
          rows: [
            {
              id: "wi-queued",
              source: "auto",
              head_sha: "abc123",
              created_at: "2026-01-01T00:00:01Z",
            },
          ],
        };
      }
      if (sql.includes("status = 'running'")) {
        return {
          rows: [
            {
              id: "wi-running",
              source: "slash",
              head_sha: "abc123",
              created_at: "2026-01-01T00:00:02Z",
            },
          ],
        };
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
    const send = vi.fn(async () => "ack-job");
    const boss = { findJobs, cancel, deleteJob, send } as unknown as PgBoss;
    const pool = { query: poolQuery } as unknown as Pool;
    const txSpy = vi
      .spyOn(postgres, "inTransaction")
      .mockImplementation(async (_pool, fn) => fn({ query: clientQuery } as unknown as PoolClient));
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
        { merged: true },
      );

      expect(txSpy).toHaveBeenCalled();
      expect(clientQuery).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO webhook_events"),
        expect.arrayContaining([REVIEW_CANCELLED_PR_MERGED]),
      );
      expect(findJobs).toHaveBeenCalledWith(
        REVIEW_QUEUE,
        expect.objectContaining({ key: "acme/app#7:review" }),
      );
      expect(cancel).toHaveBeenCalledWith(REVIEW_QUEUE, "job-queued", expect.anything());
      expect(cancel).toHaveBeenCalledWith(REVIEW_QUEUE, "job-running", expect.anything());
      expect(cancel).not.toHaveBeenCalledWith(REVIEW_QUEUE, "job-other", expect.anything());
      expect(send).toHaveBeenCalledWith(
        ACK_QUEUE,
        expect.objectContaining({
          kind: "ack",
          cancelProgress: {
            workItemId: "wi-running",
            cancelledWorkItemIds: ["wi-running", "wi-queued"],
            attribution: { kind: "merged" },
          },
        }),
        expect.anything(),
      );
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
        { merged: false },
      );

      expect(txSpy).not.toHaveBeenCalled();
      expect(poolQuery).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO webhook_events"),
        [
          expect.any(String),
          "delivery:d-closed",
          "d-closed",
          "pull_request",
          expect.any(String),
          "ignored_pull_request_closed",
        ],
      );
      expect(findJobs).not.toHaveBeenCalled();
      expect(boss.send).not.toHaveBeenCalled();
    } finally {
      txSpy.mockRestore();
    }
  });

  it("short-circuits duplicate merge-cancel deliveries before cancel SQL", async () => {
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO webhook_events")) {
        return { rows: [] };
      }
      throw new Error(`unexpected client query: ${sql.slice(0, 120)}`);
    });
    const findJobs = vi.fn(async () => []);
    const boss = {
      findJobs,
      cancel: vi.fn(),
      deleteJob: vi.fn(),
      send: vi.fn(),
    } as unknown as PgBoss;
    const pool = { query: vi.fn() } as unknown as Pool;
    const txSpy = vi
      .spyOn(postgres, "inTransaction")
      .mockImplementation(async (_pool, fn) => fn({ query: clientQuery } as unknown as PoolClient));
    const recordSpy = vi.spyOn(evlog, "recordEvent").mockImplementation(() => {});
    const intakeLog = createOperationLogger({ method: "POST", path: "/webhooks" });

    try {
      await applyAutomatedPullRequestIntake(
        boss,
        pool,
        makeHeaders("d-dup"),
        makePrRef(),
        "closed",
        intakeLog,
        intakeCfg,
        { merged: true },
      );

      expect(clientQuery.mock.calls.every((call) => !String(call[0]).includes("status ="))).toBe(
        true,
      );
      expect(findJobs).not.toHaveBeenCalled();
      expect(recordSpy).toHaveBeenCalledWith(
        intakeLog,
        "deduped_delivery",
        expect.objectContaining({ event: "pull_request" }),
        "info",
      );
    } finally {
      txSpy.mockRestore();
      recordSpy.mockRestore();
    }
  });

  it("clears failed singleton blockers when no active reviews cancel", async () => {
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO webhook_events")) {
        return { rows: [{ id: "event-zero" }] };
      }
      if (sql.includes("FROM agent_work_items") && sql.includes("status = ANY")) {
        // Failed blocker is not active; keep the unrelated live holder.
        return { rows: [{ id: "wi-live" }] };
      }
      if (sql.includes("status = 'queued'") || sql.includes("status = 'running'")) {
        return { rows: [] };
      }
      throw new Error(`unexpected client query: ${sql.slice(0, 120)}`);
    });
    const findJobs = vi.fn(async () => [
      { id: "job-failed", state: "failed", data: { workItemId: "wi-old" } },
      { id: "job-live", state: "created", data: { workItemId: "wi-live" } },
    ]);
    const cancel = vi.fn(async () => ({ rows: [] }));
    const deleteJob = vi.fn(async () => ({ rows: [] }));
    const boss = { findJobs, cancel, deleteJob, send: vi.fn() } as unknown as PgBoss;
    const pool = { query: vi.fn() } as unknown as Pool;
    const txSpy = vi
      .spyOn(postgres, "inTransaction")
      .mockImplementation(async (_pool, fn) => fn({ query: clientQuery } as unknown as PoolClient));
    const recordSpy = vi.spyOn(evlog, "recordEvent").mockImplementation(() => {});
    const intakeLog = createOperationLogger({ method: "POST", path: "/webhooks" });

    try {
      await applyAutomatedPullRequestIntake(
        boss,
        pool,
        makeHeaders("d-zero"),
        makePrRef(),
        "closed",
        intakeLog,
        intakeCfg,
        { merged: true },
      );

      expect(deleteJob).toHaveBeenCalledWith(REVIEW_QUEUE, "job-failed", expect.anything());
      expect(cancel).not.toHaveBeenCalled();
      expect(boss.send).not.toHaveBeenCalled();
      expect(recordSpy).toHaveBeenCalledWith(
        intakeLog,
        REVIEW_CANCELLED_PR_MERGED,
        expect.objectContaining({ cancelledCount: 0 }),
        "info",
      );
    } finally {
      txSpy.mockRestore();
      recordSpy.mockRestore();
    }
  });
});
