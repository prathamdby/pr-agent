import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import {
  cancelActiveReviews,
  cancelActiveTriage,
} from "../src/agentWork/intake/workItemRepository.js";
import { applyAutomatedPullRequestIntake } from "../src/agentWork/intake/applier.js";
import { makeTestConfig } from "./helpers/config.js";
import { createOperationLogger } from "../src/evlog.js";
import * as postgres from "../src/db/postgres.js";
import * as evlog from "../src/evlog.js";
import { ACK_QUEUE, REVIEW_CANCELLED_PR_CLOSED } from "../src/settings/index.js";

const intakeCfg = makeTestConfig();
const mergedAttribution = { kind: "merged" as const };
const mergedPatch = JSON.stringify({ cancelAttribution: mergedAttribution });
const closedAttribution = { kind: "closed" as const };
const closedPatch = JSON.stringify({ cancelAttribution: closedAttribution });

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

describe("cancelActiveReviews (PR close)", () => {
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

  it("cancels queued and running reviews with closed attribution", async () => {
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
          ],
        };
      }
      if (sql.includes("status = 'running'")) {
        return { rows: [] };
      }
      throw new Error(`unexpected sql: ${sql}`);
    });
    const client = { query } as unknown as PoolClient;

    const cancelled = await cancelActiveReviews(client, "acme/app#7", closedAttribution);

    expect(cancelled.map((row) => row.id)).toEqual(["queued-auto"]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("status = 'queued'"), [
      "acme/app#7",
      "Pull request closed",
      closedPatch,
    ]);
  });
});

describe("cancelActiveTriage (PR close)", () => {
  it("cancels queued and running triage and returns acknowledgement context", async () => {
    const payload = {
      source: "slash",
      commentId: 12,
      scope: "all",
      replyTarget: { kind: "prConversation", prNumber: 7 },
      ackTargets: [
        { kind: "pr", prNumber: 7 },
        { kind: "issueComment", commentId: 12 },
      ],
    } as const;
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("status = 'queued'")) {
        return {
          rows: [
            {
              id: "triage-queued",
              head_sha: "sha-q",
              created_at: "2026-01-01T00:00:01Z",
              payload,
            },
          ],
        };
      }
      if (sql.includes("status = 'running'")) {
        return {
          rows: [
            {
              id: "triage-running",
              head_sha: "sha-r",
              created_at: "2026-01-01T00:00:02Z",
              payload,
            },
          ],
        };
      }
      throw new Error(`unexpected sql: ${sql}`);
    });

    const cancelled = await cancelActiveTriage(
      { query } as unknown as PoolClient,
      "acme/app#7",
      closedAttribution,
      7,
    );

    expect(cancelled.map((row) => row.id)).toEqual(["triage-running", "triage-queued"]);
    expect(cancelled[0]).toMatchObject({
      headSha: "sha-r",
      ackTargets: payload.ackTargets,
      replyTarget: payload.replyTarget,
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("type = 'triage'"), [
      "acme/app#7",
      "Pull request closed",
      closedPatch,
    ]);
    expect(String(query.mock.calls[1]?.[0])).toContain("cancel_requested_at");
  });
});

describe("applyAutomatedPullRequestIntake close cancel", () => {
  it("cancels active reviews and enqueues cancelProgress ack when the PR is merged", async () => {
    const poolQuery = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO webhook_events")) {
        return { rows: [{ id: "event-merged" }] };
      }
      throw new Error(`unexpected pool query: ${sql.slice(0, 120)}`);
    });
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO webhook_event_replays")) {
        return { rows: [{ body_sha256: "hash" }] };
      }
      if (sql.includes("INSERT INTO webhook_events")) {
        return { rows: [{ id: "event-merged" }] };
      }
      if (sql.includes("type = 'triage'")) return { rows: [] };
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
    const send = vi.fn(async () => "ack-job");
    const boss = { send } as unknown as PgBoss;
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
        expect.arrayContaining([REVIEW_CANCELLED_PR_CLOSED]),
      );
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

  it("cancels active reviews and enqueues cancelProgress ack when the PR is closed without merge", async () => {
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO webhook_event_replays")) {
        return { rows: [{ body_sha256: "hash" }] };
      }
      if (sql.includes("INSERT INTO webhook_events")) {
        return { rows: [{ id: "event-closed" }] };
      }
      if (sql.includes("type = 'triage'")) return { rows: [] };
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
        return { rows: [] };
      }
      throw new Error(`unexpected client query: ${sql.slice(0, 120)}`);
    });
    const send = vi.fn(async () => "ack-job");
    const boss = { send } as unknown as PgBoss;
    const pool = { query: vi.fn() } as unknown as Pool;
    const txSpy = vi
      .spyOn(postgres, "inTransaction")
      .mockImplementation(async (_pool, fn) => fn({ query: clientQuery } as unknown as PoolClient));
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

      expect(txSpy).toHaveBeenCalled();
      expect(clientQuery).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO webhook_events"),
        expect.arrayContaining([REVIEW_CANCELLED_PR_CLOSED]),
      );
      expect(send).toHaveBeenCalledWith(
        ACK_QUEUE,
        expect.objectContaining({
          kind: "ack",
          cancelProgress: {
            workItemId: "wi-queued",
            cancelledWorkItemIds: ["wi-queued"],
            attribution: { kind: "closed" },
          },
        }),
        expect.anything(),
      );
    } finally {
      txSpy.mockRestore();
    }
  });

  it("cancels queued triage and enqueues a terminal no-push acknowledgement", async () => {
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO webhook_events")) {
        return { rows: [{ id: "event-triage-closed" }] };
      }
      if (sql.includes("type = 'review'")) return { rows: [] };
      if (sql.includes("type = 'triage'") && sql.includes("status = 'queued'")) {
        return {
          rows: [
            {
              id: "triage-queued",
              head_sha: "abc123",
              created_at: "2026-01-01T00:00:01Z",
              payload: {
                source: "slash",
                commentId: 31,
                scope: "all",
                replyTarget: { kind: "prConversation", prNumber: 7 },
                ackTargets: [
                  { kind: "pr", prNumber: 7 },
                  { kind: "issueComment", commentId: 31 },
                ],
              },
            },
          ],
        };
      }
      if (sql.includes("type = 'triage'")) return { rows: [] };
      throw new Error(`unexpected client query: ${sql.slice(0, 120)}`);
    });
    const send = vi.fn(async () => "ack-job");
    const boss = { send } as unknown as PgBoss;
    const pool = { query: vi.fn() } as unknown as Pool;
    const txSpy = vi
      .spyOn(postgres, "inTransaction")
      .mockImplementation(async (_pool, fn) => fn({ query: clientQuery } as unknown as PoolClient));
    const intakeLog = createOperationLogger({ method: "POST", path: "/webhooks" });

    try {
      await applyAutomatedPullRequestIntake(
        boss,
        pool,
        makeHeaders("d-triage-closed"),
        makePrRef(),
        "closed",
        intakeLog,
        intakeCfg,
        { merged: false },
      );

      expect(send).toHaveBeenCalledWith(
        ACK_QUEUE,
        expect.objectContaining({
          cancelTriage: {
            workItemId: "triage-queued",
            cancelledWorkItemIds: ["triage-queued"],
            attribution: { kind: "closed" },
            targets: [
              { kind: "pr", prNumber: 7 },
              { kind: "issueComment", commentId: 31 },
            ],
            replyTarget: { kind: "prConversation", prNumber: 7 },
          },
        }),
        expect.anything(),
      );
    } finally {
      txSpy.mockRestore();
    }
  });

  it("enqueues one ack for mixed review and triage cancellation with fallback triage targets", async () => {
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO webhook_events")) {
        return { rows: [{ id: "event-mixed-close" }] };
      }
      if (sql.includes("type = 'review'") && sql.includes("status = 'queued'")) {
        return {
          rows: [
            {
              id: "review-queued",
              source: "auto",
              head_sha: "review-q",
              created_at: "2026-01-01T00:00:01Z",
            },
          ],
        };
      }
      if (sql.includes("type = 'review'") && sql.includes("status = 'running'")) {
        return {
          rows: [
            {
              id: "review-running",
              source: "slash",
              head_sha: "review-r",
              created_at: "2026-01-01T00:00:02Z",
            },
          ],
        };
      }
      if (sql.includes("type = 'triage'") && sql.includes("status = 'queued'")) {
        return {
          rows: [
            {
              id: "triage-queued",
              head_sha: "triage-q",
              created_at: "2026-01-01T00:00:03Z",
              payload: {
                source: "slash",
                commentId: 31,
                scope: "all",
                replyTarget: { kind: "prConversation", prNumber: 7 },
              },
            },
          ],
        };
      }
      if (sql.includes("type = 'triage'") && sql.includes("status = 'running'")) {
        return {
          rows: [
            {
              id: "triage-running",
              head_sha: "triage-r",
              created_at: "2026-01-01T00:00:04Z",
              payload: {
                source: "slash",
                commentId: 31,
                scope: "all",
                replyTarget: { kind: "prConversation", prNumber: 7 },
              },
            },
          ],
        };
      }
      throw new Error(`unexpected client query: ${sql.slice(0, 120)}`);
    });
    const send = vi.fn(async () => "ack-job");
    const boss = { send } as unknown as PgBoss;
    const pool = { query: vi.fn() } as unknown as Pool;
    const txSpy = vi
      .spyOn(postgres, "inTransaction")
      .mockImplementation(async (_pool, fn) => fn({ query: clientQuery } as unknown as PoolClient));
    const intakeLog = createOperationLogger({ method: "POST", path: "/webhooks" });

    try {
      await applyAutomatedPullRequestIntake(
        boss,
        pool,
        makeHeaders("d-mixed-close"),
        makePrRef(),
        "closed",
        intakeLog,
        intakeCfg,
        { merged: false },
      );

      expect(send).toHaveBeenCalledWith(
        ACK_QUEUE,
        expect.objectContaining({
          cancelProgress: {
            workItemId: "review-running",
            cancelledWorkItemIds: ["review-running", "review-queued"],
            attribution: { kind: "closed" },
          },
          cancelTriage: {
            workItemId: "triage-running",
            cancelledWorkItemIds: ["triage-running", "triage-queued"],
            attribution: { kind: "closed" },
            targets: [
              { kind: "pr", prNumber: 7 },
              { kind: "issueComment", commentId: 31 },
            ],
            replyTarget: { kind: "prConversation", prNumber: 7 },
          },
        }),
        expect.anything(),
      );
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
    const boss = { send: vi.fn() } as unknown as PgBoss;
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

  it("records the close cancel without queue interaction when no reviews are active", async () => {
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO webhook_event_replays")) {
        return { rows: [{ body_sha256: "hash" }] };
      }
      if (sql.includes("INSERT INTO webhook_events")) {
        return { rows: [{ id: "event-zero" }] };
      }
      if (sql.includes("type = 'triage'")) return { rows: [] };
      if (sql.includes("status = 'queued'") || sql.includes("status = 'running'")) {
        return { rows: [] };
      }
      throw new Error(`unexpected client query: ${sql.slice(0, 120)}`);
    });
    const boss = { send: vi.fn() } as unknown as PgBoss;
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

      expect(boss.send).not.toHaveBeenCalled();
      expect(recordSpy).toHaveBeenCalledWith(
        intakeLog,
        REVIEW_CANCELLED_PR_CLOSED,
        expect.objectContaining({ cancelledCount: 0, prMerged: true }),
        "info",
      );
    } finally {
      txSpy.mockRestore();
      recordSpy.mockRestore();
    }
  });
});
