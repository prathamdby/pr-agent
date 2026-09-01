import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import { AppError } from "../src/errors/appError.js";
import { ACK_QUEUE, DEFERRED_HEAD_SHA, REVIEW_QUEUE } from "../src/settings/index.js";
import {
  buildStaleReviewRescheduleResult,
  cancelOrphanedStaleHeadReplacementOnTerminalFailure,
  cancelUnenqueuedStaleHeadReplacement,
  createReviewRescheduleWorkItem,
  enqueueReviewReschedule,
  STALE_HEAD_PARENT_NOT_RESCHEDULABLE,
  STALE_HEAD_REPLACEMENT_EXHAUSTED,
  isStaleHeadReplacementExhausted,
  staleHeadReplacementExhaustedError,
  tryBuildStaleReviewRescheduleResult,
} from "../src/agentWork/reviewReschedule.js";
import type { ReviewWorkItem } from "../src/agentWork/types.js";
import { makeReviewWorkItem } from "./helpers/agentWorkItems.js";

const mocks = vi.hoisted(() => ({
  lockPrActorLeaseForUpdate: vi.fn(),
}));

vi.mock("../src/agentWork/repository.js", () => ({
  getWorkItem: vi.fn(),
  markQueuedWorkCancelled: vi.fn(),
}));
vi.mock("../src/agentWork/prActorLease.js", () => ({
  lockPrActorLeaseForUpdate: mocks.lockPrActorLeaseForUpdate,
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
import * as evlog from "../src/evlog.js";

const LEASE_EPOCH = 7;

function pendingReplacement(replacementWorkItemId: string) {
  return {
    staleHeadReplacement: {
      replacementWorkItemId,
      state: "pending-enqueue" as const,
    },
  };
}

function enqueuedReplacement(replacementWorkItemId: string) {
  return {
    staleHeadReplacement: {
      replacementWorkItemId,
      state: "enqueued" as const,
    },
  };
}

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
  mocks.lockPrActorLeaseForUpdate.mockResolvedValue(undefined);
});

describe("createReviewRescheduleWorkItem", () => {
  it("rejects a stale lease epoch before marker persistence", async () => {
    const leaseLost = new AppError({
      code: "agent_work.pr_actor_lease_lost",
      message: "PR actor lease is no longer held by this execution",
    });
    mocks.lockPrActorLeaseForUpdate.mockRejectedValue(leaseLost);
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{ id: "parent-wi", head_sha: DEFERRED_HEAD_SHA }],
    });
    const pool = { query } as unknown as Pool;
    const item = makeItem({
      payload: {
        mode: "review",
        source: "slash",
        ...pendingReplacement("existing-replacement"),
      },
    });

    await expect(createReviewRescheduleWorkItem(pool, item, 99)).rejects.toBe(leaseLost);

    expect(query).not.toHaveBeenCalled();
  });

  it("keeps the first persisted head_sha when replacement row already exists", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "parent-wi" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ head_sha: "persisted-head" }] })
      .mockResolvedValue({ rowCount: 1, rows: [] });
    const pool = { query } as unknown as Pool;

    const replacement = await createReviewRescheduleWorkItem(
      pool,
      makeItem({
        payload: {
          mode: "review",
          source: "slash",
          ...pendingReplacement("existing-replacement"),
        },
      }),
      LEASE_EPOCH,
    );

    expect(replacement).toEqual({
      replacementWorkItemId: "existing-replacement",
      headSha: "persisted-head",
    });
    const insertSql = String(query.mock.calls[1]?.[0]);
    expect(insertSql).toContain("RETURNING head_sha");
    expect(insertSql).not.toContain("head_sha = EXCLUDED.head_sha");
  });

  it("reuses persisted replacement id without creating a new marker", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "parent-wi" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ head_sha: DEFERRED_HEAD_SHA }] })
      .mockResolvedValue({ rowCount: 1, rows: [] });
    const pool = { query } as unknown as Pool;

    const replacement = await createReviewRescheduleWorkItem(
      pool,
      makeItem({
        payload: {
          mode: "review",
          source: "slash",
          ...pendingReplacement("existing-replacement"),
        },
      }),
      LEASE_EPOCH,
    );

    expect(replacement.replacementWorkItemId).toBe("existing-replacement");
    expect(query.mock.calls.some((call) => String(call[0]).includes("FOR UPDATE"))).toBe(true);
  });

  it("persists marker then inserts a deferred-head replacement on first attempt", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "parent-wi" }] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ replacement_id: "generated-replacement" }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ head_sha: DEFERRED_HEAD_SHA }] })
      .mockResolvedValue({ rowCount: 1, rows: [] });
    const pool = { query } as unknown as Pool;

    const replacement = await createReviewRescheduleWorkItem(pool, makeItem(), LEASE_EPOCH);

    expect(replacement).toEqual({
      replacementWorkItemId: "generated-replacement",
      headSha: DEFERRED_HEAD_SHA,
    });
    expect(String(query.mock.calls[1]?.[0])).toContain("staleHeadReplacement");
    expect(JSON.parse(String(query.mock.calls[1]?.[1]?.[1]))).toEqual({
      staleHeadReplacement: {
        replacementWorkItemId: expect.any(String),
        state: "pending-enqueue",
      },
    });
    expect(query.mock.calls[2]?.[1]?.[7]).toBe(DEFERRED_HEAD_SHA);
    const replacementPayload = JSON.parse(String(query.mock.calls[2]?.[1]?.[10]));
    expect(replacementPayload).toMatchObject({
      source: "slash",
      staleHeadRescheduled: true,
    });
    expect(replacementPayload.staleHeadReplacement).toBeUndefined();
  });

  it("refuses to create a replacement when the parent is already cancel-requested", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    const pool = { query } as unknown as Pool;

    await expect(
      createReviewRescheduleWorkItem(pool, makeItem(), LEASE_EPOCH),
    ).rejects.toMatchObject({
      code: STALE_HEAD_PARENT_NOT_RESCHEDULABLE,
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("preserves auto source on the replacement work item and ack", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "parent-wi" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ head_sha: DEFERRED_HEAD_SHA }] })
      .mockResolvedValue({ rowCount: 1, rows: [] });
    const pool = { query } as unknown as Pool;
    const send = vi.fn().mockResolvedValue("job-id");
    const findJobs = vi.fn().mockResolvedValue([]);
    const cancel = vi.fn();
    const boss = { send, findJobs, cancel } as unknown as PgBoss;
    const parent = makeItem({
      source: "auto",
      payload: {
        mode: "review",
        source: "auto",
        ...pendingReplacement("auto-replacement"),
      },
    });

    const result = await buildStaleReviewRescheduleResult(pool, parent, LEASE_EPOCH);
    const insertParams = query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO agent_work_items"),
    )?.[1] as unknown[] | undefined;
    expect(insertParams?.[2]).toBe("auto");
    await result.afterComplete(boss);

    const ackCall = send.mock.calls.find(([queue]) => queue === ACK_QUEUE);
    expect(ackCall?.[1]).toMatchObject({
      progress: { source: "auto", headSha: DEFERRED_HEAD_SHA },
    });
  });

  it("reuses marker from refreshed parent when concurrent update wins", async () => {
    vi.mocked(getWorkItem).mockResolvedValue(
      makeItem({
        payload: {
          mode: "review",
          source: "slash",
          ...pendingReplacement("winner-replacement"),
        },
      }),
    );
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "parent-wi" }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ head_sha: DEFERRED_HEAD_SHA }] })
      .mockResolvedValue({ rowCount: 1, rows: [] });
    const pool = { query } as unknown as Pool;

    const replacement = await createReviewRescheduleWorkItem(pool, makeItem(), LEASE_EPOCH);

    expect(replacement.replacementWorkItemId).toBe("winner-replacement");
    expect(getWorkItem).toHaveBeenCalledWith(pool, "parent-wi");
  });

  it("uses the persisted replacement head for the ack after an insert conflict", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "parent-wi" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ head_sha: "persisted-head" }] })
      .mockResolvedValue({ rowCount: 1, rows: [] });
    const pool = { query } as unknown as Pool;
    const send = vi.fn().mockResolvedValue("job-id");
    const findJobs = vi.fn().mockResolvedValue([]);
    const cancel = vi.fn();
    const boss = { send, findJobs, cancel } as unknown as PgBoss;

    const result = await buildStaleReviewRescheduleResult(
      pool,
      makeItem({
        payload: {
          mode: "review",
          source: "slash",
          ...pendingReplacement("existing-replacement"),
        },
      }),
      LEASE_EPOCH,
    );
    await result.afterComplete(boss);

    const ackCall = send.mock.calls.find(([queue]) => queue === ACK_QUEUE);
    expect(ackCall?.[1]).toMatchObject({
      progress: { headSha: "persisted-head" },
    });
  });
});

describe("stale-head shared helpers", () => {
  it("tryBuild returns null when the parent is not reschedulable", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    const pool = { query } as unknown as Pool;

    await expect(
      tryBuildStaleReviewRescheduleResult(pool, makeItem(), LEASE_EPOCH),
    ).resolves.toBeNull();
  });

  it("tryBuild returns a reschedule result for a live parent", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "parent-wi" }] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ replacement_id: "generated-replacement" }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ head_sha: DEFERRED_HEAD_SHA }] })
      .mockResolvedValue({ rowCount: 1, rows: [] });
    const pool = { query } as unknown as Pool;

    const result = await tryBuildStaleReviewRescheduleResult(pool, makeItem(), LEASE_EPOCH);
    expect(result).toMatchObject({
      kind: "rescheduled",
      replacementWorkItemId: "generated-replacement",
    });
    expect(typeof result?.afterComplete).toBe("function");
    expect(typeof result?.onRescheduleAbort).toBe("function");
  });

  it("staleHeadReplacementExhaustedError uses the shared exhausted code", () => {
    const error = staleHeadReplacementExhaustedError(makeItem());
    expect(error.code).toBe(STALE_HEAD_REPLACEMENT_EXHAUSTED);
    expect(error.message).toMatch(/\/review/);
    expect(isStaleHeadReplacementExhausted(error)).toBe(true);
    expect(isStaleHeadReplacementExhausted(new Error("other"))).toBe(false);
  });
});

describe("enqueueReviewReschedule", () => {
  it("rejects a stale lease epoch before deterministic enqueue", async () => {
    const leaseLost = new AppError({
      code: "agent_work.pr_actor_lease_lost",
      message: "PR actor lease is no longer held by this execution",
    });
    mocks.lockPrActorLeaseForUpdate.mockRejectedValue(leaseLost);
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    const pool = { query } as unknown as Pool;
    const send = vi.fn().mockResolvedValue("job-id");
    const findJobs = vi.fn().mockResolvedValue([]);
    const boss = { send, findJobs } as unknown as PgBoss;

    await expect(
      enqueueReviewReschedule(pool, boss, makeItem(), "replacement-wi", "newhead", 99),
    ).rejects.toBe(leaseLost);

    expect(findJobs).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("does not cancel a co-queued foreign work item on the singleton", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM agent_work_items") && sql.includes("status = ANY")) {
        return {
          rowCount: 2,
          rows: [{ id: "slash-waiting" }, { id: "replacement-wi" }],
        };
      }
      return { rowCount: 1, rows: [] };
    });
    const pool = { query } as unknown as Pool;
    const send = vi.fn().mockResolvedValue("job-id");
    const findJobs = vi.fn().mockResolvedValue([
      {
        id: "foreign-job",
        state: "created",
        data: { kind: "review", workItemId: "slash-waiting" },
      },
      {
        id: "active-job",
        state: "active",
        data: { kind: "review", workItemId: "replacement-wi" },
      },
    ]);
    const cancel = vi.fn();
    const deleteJob = vi.fn();
    const boss = { send, findJobs, cancel, deleteJob } as unknown as PgBoss;

    await enqueueReviewReschedule(pool, boss, makeItem(), "replacement-wi", "newhead", LEASE_EPOCH);

    expect(cancel).not.toHaveBeenCalled();
    expect(deleteJob).not.toHaveBeenCalled();
  });

  it("repairs a stale enqueue marker when replacement jobs are absent", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    const pool = { query } as unknown as Pool;
    const send = vi.fn().mockResolvedValue("job-id");
    const findJobs = vi.fn().mockResolvedValue([]);
    const cancel = vi.fn();
    const boss = { send, findJobs, cancel } as unknown as PgBoss;

    await enqueueReviewReschedule(
      pool,
      boss,
      makeItem({
        payload: {
          mode: "review",
          source: "slash",
          ...enqueuedReplacement("replacement-wi"),
        },
      }),
      "replacement-wi",
      "newhead",
      LEASE_EPOCH,
    );

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]).toBe(REVIEW_QUEUE);
    expect(send.mock.calls[1]?.[0]).toBe(ACK_QUEUE);
    expect(query.mock.calls[0]?.[1]?.[1]).toBe(
      JSON.stringify({
        staleHeadReplacement: { replacementWorkItemId: "replacement-wi", state: "enqueued" },
      }),
    );
  });

  it("sends the replacement review job before the ack job", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    const pool = { query } as unknown as Pool;
    const send = vi.fn().mockResolvedValue("job-id");
    const findJobs = vi.fn().mockResolvedValue([]);
    const cancel = vi.fn();
    const boss = { send, findJobs, cancel } as unknown as PgBoss;

    await enqueueReviewReschedule(pool, boss, makeItem(), "replacement-wi", "newhead", LEASE_EPOCH);

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]).toBe(REVIEW_QUEUE);
    expect(send.mock.calls[1]?.[0]).toBe(ACK_QUEUE);
    expect(send.mock.calls[0]?.[2]).toMatchObject({
      db: expect.any(Object),
      id: "replacement-wi",
    });
    expect(send.mock.calls[1]?.[2]).toMatchObject({
      db: expect.any(Object),
      id: "replacement-wi",
    });
  });

  it("reuses an existing replacement review job after a partial enqueue", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    const pool = { query } as unknown as Pool;
    const send = vi.fn().mockResolvedValue("ack-job");
    const existingReplacement = {
      id: "review-job",
      state: "created",
      data: { kind: "review", workItemId: "replacement-wi" },
    };
    const findJobs = vi.fn().mockResolvedValueOnce([existingReplacement]).mockResolvedValueOnce([]);
    const cancel = vi.fn();
    const boss = { send, findJobs, cancel } as unknown as PgBoss;

    await enqueueReviewReschedule(pool, boss, makeItem(), "replacement-wi", "newhead", LEASE_EPOCH);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBe(ACK_QUEUE);
    expect(cancel).not.toHaveBeenCalled();
    expect(
      query.mock.calls.some((call) => String(call[1]?.[1]).includes('"state":"enqueued"')),
    ).toBe(true);
  });

  it("accepts a deterministic review job id that is already terminal", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    const pool = { query } as unknown as Pool;
    const send = vi.fn().mockResolvedValue("ack-job");
    const existingReview = {
      id: "replacement-wi",
      state: "completed",
      data: { kind: "review", workItemId: "replacement-wi" },
    };
    const findJobs = vi.fn().mockResolvedValueOnce([existingReview]).mockResolvedValueOnce([]);
    const cancel = vi.fn();
    const boss = { send, findJobs, cancel } as unknown as PgBoss;

    await enqueueReviewReschedule(pool, boss, makeItem(), "replacement-wi", "newhead", LEASE_EPOCH);

    expect(send).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
    expect(query.mock.calls[0]?.[1]?.[1]).toBe(
      JSON.stringify({
        staleHeadReplacement: { replacementWorkItemId: "replacement-wi", state: "enqueued" },
      }),
    );
  });

  it("fails when a missing deterministic job returns null", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    const pool = { query } as unknown as Pool;
    const send = vi.fn().mockResolvedValue(null);
    const findJobs = vi.fn().mockResolvedValue([]);
    const cancel = vi.fn();
    const boss = { send, findJobs, cancel } as unknown as PgBoss;

    await expect(
      enqueueReviewReschedule(pool, boss, makeItem(), "replacement-wi", "newhead", LEASE_EPOCH),
    ).rejects.toMatchObject({ code: "agent_work.reschedule_enqueue_failed" });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBe(REVIEW_QUEUE);
    expect(query).not.toHaveBeenCalled();
  });

  it("does not mark replacement enqueued when the ack job is missing", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    const pool = { query } as unknown as Pool;
    const send = vi.fn().mockResolvedValueOnce("review-job").mockResolvedValueOnce(null);
    const findJobs = vi.fn().mockResolvedValue([]);
    const cancel = vi.fn();
    const boss = { send, findJobs, cancel } as unknown as PgBoss;

    await expect(
      enqueueReviewReschedule(pool, boss, makeItem(), "replacement-wi", "newhead", LEASE_EPOCH),
    ).rejects.toMatchObject({ code: "agent_work.reschedule_enqueue_failed" });

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]).toBe(REVIEW_QUEUE);
    expect(send.mock.calls[1]?.[0]).toBe(ACK_QUEUE);
    expect(query).not.toHaveBeenCalled();
  });

  it("does not mark or send an ack when replacement review enqueue throws", async () => {
    const query = vi.fn();
    const pool = { query } as unknown as Pool;
    const send = vi.fn().mockRejectedValueOnce(new Error("review queue unavailable"));
    const findJobs = vi.fn().mockResolvedValue([]);
    const cancel = vi.fn();
    const boss = { send, findJobs, cancel } as unknown as PgBoss;

    await expect(
      enqueueReviewReschedule(pool, boss, makeItem(), "replacement-wi", "newhead", LEASE_EPOCH),
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

describe("buildStaleReviewRescheduleResult onRescheduleAbort", () => {
  it("cancels un-enqueued replacement when afterComplete never ran", async () => {
    vi.mocked(markQueuedWorkCancelled).mockResolvedValue(true);
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{ head_sha: "latest-head" }],
    });
    const pool = { query } as unknown as Pool;
    const boom = new Error("parent failed");
    const boss = bossWithReviewJobs();

    const result = await buildStaleReviewRescheduleResult(
      pool,
      makeItem({
        payload: {
          mode: "review",
          source: "slash",
          ...pendingReplacement("existing-replacement"),
        },
      }),
      LEASE_EPOCH,
    );
    await result.onRescheduleAbort(boss, boom);

    expect(markQueuedWorkCancelled).toHaveBeenCalledWith(pool, "existing-replacement", boom);
  });

  it("does not cancel after afterComplete marks the replacement enqueued", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "parent-wi" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ head_sha: "persisted-head" }] })
      .mockResolvedValue({ rowCount: 1, rows: [] });
    const pool = { query } as unknown as Pool;
    const send = vi.fn().mockResolvedValue("job-id");
    const findJobs = vi.fn().mockResolvedValue([]);
    const cancel = vi.fn();
    const boss = { send, findJobs, cancel } as unknown as PgBoss;

    const result = await buildStaleReviewRescheduleResult(
      pool,
      makeItem({
        payload: {
          mode: "review",
          source: "slash",
          ...pendingReplacement("existing-replacement"),
        },
      }),
      LEASE_EPOCH,
    );
    await result.afterComplete(boss);
    await result.onRescheduleAbort(boss, new Error("should not cancel"));

    expect(markQueuedWorkCancelled).not.toHaveBeenCalled();
  });

  it("does not trust a persisted enqueue marker before jobs are verified", async () => {
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{ head_sha: "latest-head" }],
    });
    const pool = { query } as unknown as Pool;
    const boss = bossWithReviewJobs();

    const result = await buildStaleReviewRescheduleResult(
      pool,
      makeItem({
        payload: {
          mode: "review",
          source: "slash",
          ...enqueuedReplacement("existing-replacement"),
        },
      }),
      LEASE_EPOCH,
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
        ...pendingReplacement("replacement-wi"),
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

  it("cancels a pending-enqueue replacement and skips an enqueued one", async () => {
    vi.mocked(markQueuedWorkCancelled).mockResolvedValue(true);
    const pool = {} as Pool;
    const boss = bossWithReviewJobs();
    const boom = new Error("terminal");

    await cancelOrphanedStaleHeadReplacementOnTerminalFailure(
      pool,
      boss,
      makeItem({
        payload: { mode: "review", source: "slash", ...pendingReplacement("pending-wi") },
      }),
      boom,
    );
    expect(markQueuedWorkCancelled).toHaveBeenCalledWith(pool, "pending-wi", boom);

    vi.mocked(markQueuedWorkCancelled).mockClear();
    await cancelOrphanedStaleHeadReplacementOnTerminalFailure(
      pool,
      boss,
      makeItem({
        payload: { mode: "review", source: "slash", ...enqueuedReplacement("enqueued-wi") },
      }),
      boom,
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
          ...enqueuedReplacement("replacement-wi"),
        },
      }),
      new Error("dead"),
    );

    expect(markQueuedWorkCancelled).not.toHaveBeenCalled();
  });
});
