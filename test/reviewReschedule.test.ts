import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import { ACK_QUEUE, REVIEW_QUEUE } from "../src/settings/index.js";
import {
  buildStaleSlashReviewRescheduleResult,
  cancelOrphanedStaleHeadReplacementOnTerminalFailure,
  cancelUnenqueuedStaleHeadReplacement,
  createSlashReviewRescheduleWorkItem,
  enqueueSlashReviewReschedule,
} from "../src/agentWork/reviewReschedule.js";
import type { ReviewWorkItem } from "../src/agentWork/types.js";
import { makeReviewWorkItem } from "./helpers/agentWorkItems.js";

vi.mock("../src/agentWork/repository.js", () => ({
  getWorkItem: vi.fn(),
  markQueuedWorkCancelled: vi.fn(),
}));
vi.mock("../src/agentWork/githubPrSurface.js", () => ({
  getPullRequestHeadSha: vi.fn(),
}));
vi.mock("../src/db/postgres.js", () => ({
  inTransaction: async (
    pool: Pool,
    fn: (client: PoolClient) => Promise<unknown>,
  ): Promise<unknown> => fn(pool as unknown as PoolClient),
  pgBossDb: (client: PoolClient) => ({
    executeSql: (text: string, values?: unknown[]) => client.query(text, values),
  }),
}));
vi.mock("../src/evlog.js", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { getWorkItem, markQueuedWorkCancelled } from "../src/agentWork/repository.js";
import { getPullRequestHeadSha } from "../src/agentWork/githubPrSurface.js";
import * as evlog from "../src/evlog.js";

function makeItem(
  overrides: Parameters<typeof makeReviewWorkItem>[0] & { attemptCount?: number } = {},
): ReviewWorkItem {
  return makeReviewWorkItem({
    id: "parent-wi",
    source: "slash",
    attemptCount: 1,
    ...overrides,
  });
}

function bossWithReviewJobs(jobs: unknown[] = []): PgBoss {
  return {
    findJobs: vi.fn().mockResolvedValue(jobs),
  } as unknown as PgBoss;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createSlashReviewRescheduleWorkItem", () => {
  it("keeps the first persisted head_sha when replacement row already exists", async () => {
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{ head_sha: "persisted-head" }],
    });
    const pool = { query } as unknown as Pool;

    const replacement = await createSlashReviewRescheduleWorkItem(
      pool,
      makeItem({
        payload: {
          mode: "review",
          source: "slash",
          staleHeadReplacementWorkItemId: "existing-replacement",
        },
      }),
      "newhead",
    );

    expect(replacement).toEqual({
      replacementWorkItemId: "existing-replacement",
      headSha: "persisted-head",
    });
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("RETURNING head_sha");
    expect(sql).not.toContain("head_sha = EXCLUDED.head_sha");
  });

  it("reuses persisted replacement id without creating a new marker", async () => {
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{ head_sha: "newhead" }],
    });
    const pool = { query } as unknown as Pool;

    const replacement = await createSlashReviewRescheduleWorkItem(
      pool,
      makeItem({
        payload: {
          mode: "review",
          source: "slash",
          staleHeadReplacementWorkItemId: "existing-replacement",
        },
      }),
      "newhead",
    );

    expect(replacement.replacementWorkItemId).toBe("existing-replacement");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("persists marker then inserts replacement on first attempt", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ replacement_id: "generated-replacement" }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ head_sha: "newhead" }] });
    const pool = { query } as unknown as Pool;

    const replacement = await createSlashReviewRescheduleWorkItem(pool, makeItem(), "newhead");

    expect(replacement.replacementWorkItemId).toBe("generated-replacement");
    expect(query).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[0]?.[0])).toContain(
      "payload->>'staleHeadReplacementWorkItemId') IS NULL",
    );
  });

  it("reuses marker from refreshed parent when concurrent update wins", async () => {
    vi.mocked(getWorkItem).mockResolvedValue(
      makeItem({
        payload: {
          mode: "review",
          source: "slash",
          staleHeadReplacementWorkItemId: "winner-replacement",
        },
      }),
    );
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ head_sha: "newhead" }] });
    const pool = { query } as unknown as Pool;

    const replacement = await createSlashReviewRescheduleWorkItem(pool, makeItem(), "newhead");

    expect(replacement.replacementWorkItemId).toBe("winner-replacement");
    expect(getWorkItem).toHaveBeenCalledWith(pool, "parent-wi");
  });

  it("uses the persisted replacement head for the ack after an insert conflict", async () => {
    vi.mocked(getPullRequestHeadSha).mockResolvedValue("latest-head");
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ head_sha: "persisted-head" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const pool = { query } as unknown as Pool;
    const send = vi.fn().mockResolvedValue("job-id");
    const findJobs = vi.fn().mockResolvedValue([]);
    const cancel = vi.fn();
    const boss = { send, findJobs, cancel } as unknown as PgBoss;

    const result = await buildStaleSlashReviewRescheduleResult(
      pool,
      makeItem({
        payload: {
          mode: "review",
          source: "slash",
          staleHeadReplacementWorkItemId: "existing-replacement",
        },
      }),
      "token",
    );
    await result.afterComplete(boss, "active-job");

    const ackCall = send.mock.calls.find(([queue]) => queue === ACK_QUEUE);
    expect(ackCall?.[1]).toMatchObject({
      progress: { headSha: "persisted-head" },
    });
  });
});

describe("enqueueSlashReviewReschedule", () => {
  it("repairs a stale enqueue marker when replacement jobs are absent", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    const pool = { query } as unknown as Pool;
    const send = vi.fn().mockResolvedValue("job-id");
    const findJobs = vi.fn().mockResolvedValue([]);
    const cancel = vi.fn();
    const boss = { send, findJobs, cancel } as unknown as PgBoss;

    await enqueueSlashReviewReschedule(
      pool,
      boss,
      makeItem({
        payload: {
          mode: "review",
          source: "slash",
          staleHeadReplacementEnqueued: true,
          staleHeadReplacementWorkItemId: "replacement-wi",
        },
      }),
      "replacement-wi",
      "newhead",
    );

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]).toBe(REVIEW_QUEUE);
    expect(send.mock.calls[1]?.[0]).toBe(ACK_QUEUE);
    expect(String(query.mock.calls[0]?.[0])).toContain("staleHeadReplacementEnqueued");
  });

  it("sends the replacement review job before the ack job", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    const pool = { query } as unknown as Pool;
    const send = vi.fn().mockResolvedValue("job-id");
    const findJobs = vi.fn().mockResolvedValue([]);
    const cancel = vi.fn();
    const boss = { send, findJobs, cancel } as unknown as PgBoss;

    await enqueueSlashReviewReschedule(pool, boss, makeItem(), "replacement-wi", "newhead");

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]).toBe(REVIEW_QUEUE);
    expect(send.mock.calls[1]?.[0]).toBe(ACK_QUEUE);
    expect(send.mock.calls[0]?.[2]).toMatchObject({
      db: expect.any(Object),
      id: "replacement-wi",
      singletonKey: "o/r#1:review",
    });
    expect(send.mock.calls[1]?.[2]).toMatchObject({
      db: expect.any(Object),
      id: "replacement-wi",
    });
  });

  it("reuses an existing replacement review job after a partial enqueue", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    const pool = { query } as unknown as Pool;
    const send = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce("ack-job");
    const existingReplacement = {
      id: "review-job",
      state: "created",
      data: { kind: "review", workItemId: "replacement-wi" },
    };
    const findJobs = vi.fn().mockResolvedValue([existingReplacement]);
    const cancel = vi.fn();
    const boss = { send, findJobs, cancel } as unknown as PgBoss;

    await enqueueSlashReviewReschedule(pool, boss, makeItem(), "replacement-wi", "newhead");

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]).toBe(REVIEW_QUEUE);
    expect(send.mock.calls[1]?.[0]).toBe(ACK_QUEUE);
    expect(cancel).not.toHaveBeenCalled();
    expect(String(query.mock.calls[0]?.[0])).toContain("staleHeadReplacementEnqueued");
  });

  it("accepts a deterministic review job id that is already terminal", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    const pool = { query } as unknown as Pool;
    const send = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    const findJobs = vi.fn().mockResolvedValue([
      {
        id: "replacement-wi",
        state: "completed",
        data: { kind: "review", workItemId: "replacement-wi" },
      },
    ]);
    const cancel = vi.fn();
    const boss = { send, findJobs, cancel } as unknown as PgBoss;

    await enqueueSlashReviewReschedule(pool, boss, makeItem(), "replacement-wi", "newhead");

    expect(send).toHaveBeenCalledTimes(2);
    expect(cancel).not.toHaveBeenCalled();
    expect(String(query.mock.calls[0]?.[0])).toContain("staleHeadReplacementEnqueued");
  });

  it("does not mark or send an ack when replacement review enqueue throws", async () => {
    const query = vi.fn();
    const pool = { query } as unknown as Pool;
    const send = vi.fn().mockRejectedValueOnce(new Error("review queue unavailable"));
    const findJobs = vi.fn().mockResolvedValue([]);
    const cancel = vi.fn();
    const boss = { send, findJobs, cancel } as unknown as PgBoss;

    await expect(
      enqueueSlashReviewReschedule(pool, boss, makeItem(), "replacement-wi", "newhead"),
    ).rejects.toThrow(/review queue unavailable/);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBe(REVIEW_QUEUE);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("cancelUnenqueuedStaleHeadReplacement", () => {
  it("cancels a queued replacement when not yet enqueued", async () => {
    vi.mocked(markQueuedWorkCancelled).mockResolvedValue(true);
    const boom = new Error("enqueue failed");
    const pool = {} as Pool;
    const boss = bossWithReviewJobs();

    await cancelUnenqueuedStaleHeadReplacement(
      pool,
      boss,
      makeItem(),
      "replacement-wi",
      boom,
      false,
    );

    expect(markQueuedWorkCancelled).toHaveBeenCalledWith(pool, "replacement-wi", boom);
  });

  it("skips cancel when replacement was already enqueued", async () => {
    const pool = {} as Pool;
    const boss = bossWithReviewJobs();

    await cancelUnenqueuedStaleHeadReplacement(
      pool,
      boss,
      makeItem(),
      "replacement-wi",
      new Error("dead"),
      true,
    );

    expect(markQueuedWorkCancelled).not.toHaveBeenCalled();
  });

  it("skips cancel when a replacement review job is live", async () => {
    const pool = {} as Pool;
    const boss = bossWithReviewJobs([
      {
        state: "created",
        data: { kind: "review", workItemId: "replacement-wi" },
      },
    ]);

    await cancelUnenqueuedStaleHeadReplacement(
      pool,
      boss,
      makeItem(),
      "replacement-wi",
      new Error("parent failed"),
      false,
    );

    expect(markQueuedWorkCancelled).not.toHaveBeenCalled();
  });

  it("warns when queued replacement cancel races or misses", async () => {
    vi.mocked(markQueuedWorkCancelled).mockResolvedValue(false);
    const pool = {} as Pool;
    const boss = bossWithReviewJobs();

    await cancelUnenqueuedStaleHeadReplacement(
      pool,
      boss,
      makeItem(),
      "replacement-wi",
      new Error("enqueue failed"),
      false,
    );

    expect(evlog.logWarn).toHaveBeenCalledWith(
      "agent_work_replacement_cancel_failed",
      expect.objectContaining({
        type: "review",
        workItemId: "parent-wi",
        replacementWorkItemId: "replacement-wi",
      }),
    );
  });

  it("warns and swallows cancel errors", async () => {
    vi.mocked(markQueuedWorkCancelled).mockRejectedValue(new Error("db down"));
    const pool = {} as Pool;
    const boss = bossWithReviewJobs();

    await expect(
      cancelUnenqueuedStaleHeadReplacement(
        pool,
        boss,
        makeItem(),
        "replacement-wi",
        new Error("enqueue failed"),
        false,
      ),
    ).resolves.toBeUndefined();

    expect(evlog.logWarn).toHaveBeenCalledWith(
      "agent_work_replacement_cancel_failed",
      expect.objectContaining({
        type: "review",
        workItemId: "parent-wi",
        replacementWorkItemId: "replacement-wi",
        message: expect.stringMatching(/db down/),
      }),
    );
  });
});

describe("buildStaleSlashReviewRescheduleResult onRescheduleAbort", () => {
  it("cancels un-enqueued replacement when afterComplete never ran", async () => {
    vi.mocked(getPullRequestHeadSha).mockResolvedValue("latest-head");
    vi.mocked(markQueuedWorkCancelled).mockResolvedValue(true);
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{ head_sha: "latest-head" }],
    });
    const pool = { query } as unknown as Pool;
    const boom = new Error("parent failed");
    const boss = bossWithReviewJobs();

    const result = await buildStaleSlashReviewRescheduleResult(
      pool,
      makeItem({
        payload: {
          mode: "review",
          source: "slash",
          staleHeadReplacementWorkItemId: "existing-replacement",
        },
      }),
      "token",
    );
    await result.onRescheduleAbort(boss, boom);

    expect(markQueuedWorkCancelled).toHaveBeenCalledWith(pool, "existing-replacement", boom);
  });

  it("does not cancel after afterComplete marks the replacement enqueued", async () => {
    vi.mocked(getPullRequestHeadSha).mockResolvedValue("latest-head");
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ head_sha: "persisted-head" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const pool = { query } as unknown as Pool;
    const send = vi.fn().mockResolvedValue("job-id");
    const findJobs = vi.fn().mockResolvedValue([]);
    const cancel = vi.fn();
    const boss = { send, findJobs, cancel } as unknown as PgBoss;

    const result = await buildStaleSlashReviewRescheduleResult(
      pool,
      makeItem({
        payload: {
          mode: "review",
          source: "slash",
          staleHeadReplacementWorkItemId: "existing-replacement",
        },
      }),
      "token",
    );
    await result.afterComplete(boss, "active-job");
    await result.onRescheduleAbort(boss, new Error("should not cancel"));

    expect(markQueuedWorkCancelled).not.toHaveBeenCalled();
  });

  it("does not trust a persisted enqueue marker before jobs are verified", async () => {
    vi.mocked(getPullRequestHeadSha).mockResolvedValue("latest-head");
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{ head_sha: "latest-head" }],
    });
    const pool = { query } as unknown as Pool;
    const boss = bossWithReviewJobs();

    const result = await buildStaleSlashReviewRescheduleResult(
      pool,
      makeItem({
        payload: {
          mode: "review",
          source: "slash",
          staleHeadReplacementWorkItemId: "existing-replacement",
          staleHeadReplacementEnqueued: true,
        },
      }),
      "token",
    );
    const error = new Error("parent failed");
    await result.onRescheduleAbort(boss, error);

    expect(markQueuedWorkCancelled).toHaveBeenCalledWith(pool, "existing-replacement", error);
  });
});

describe("cancelOrphanedStaleHeadReplacementOnTerminalFailure", () => {
  it("cancels via the parent payload marker when replacement was never enqueued", async () => {
    vi.mocked(markQueuedWorkCancelled).mockResolvedValue(true);
    const boom = new Error("terminal before reschedule result");
    const pool = {} as Pool;
    const boss = bossWithReviewJobs();
    const parent = makeItem({
      payload: {
        mode: "review",
        source: "slash",
        staleHeadReplacementWorkItemId: "replacement-wi",
      },
    });

    await cancelOrphanedStaleHeadReplacementOnTerminalFailure(pool, boss, parent, boom);

    expect(markQueuedWorkCancelled).toHaveBeenCalledWith(pool, "replacement-wi", boom);
  });

  it("no-ops when the parent payload has no replacement marker", async () => {
    const pool = {} as Pool;
    const boss = bossWithReviewJobs();

    await cancelOrphanedStaleHeadReplacementOnTerminalFailure(
      pool,
      boss,
      makeItem({ payload: { mode: "review", source: "slash" } }),
      new Error("dead"),
    );

    expect(markQueuedWorkCancelled).not.toHaveBeenCalled();
  });

  it("no-ops when the payload marks the replacement as already enqueued", async () => {
    const pool = {} as Pool;
    const boss = bossWithReviewJobs();

    await cancelOrphanedStaleHeadReplacementOnTerminalFailure(
      pool,
      boss,
      makeItem({
        payload: {
          mode: "review",
          source: "slash",
          staleHeadReplacementWorkItemId: "replacement-wi",
          staleHeadReplacementEnqueued: true,
        },
      }),
      new Error("dead"),
    );

    expect(markQueuedWorkCancelled).not.toHaveBeenCalled();
  });
});
