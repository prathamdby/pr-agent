import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import { AppError } from "../src/errors/appError.ts";
import { ACK_QUEUE, DEFERRED_HEAD_SHA, REVIEW_QUEUE } from "../src/settings/index.ts";
import {
  buildStaleReviewRescheduleResult,
  cancelPendingPushFollowUp,
  cancelPendingStaleHeadReplacement,
  createReviewRescheduleWorkItem,
  schedulePushFollowUp,
  enqueueReviewReschedule,
  isStaleHeadReplacementExhausted,
  staleHeadReplacementExhaustedError,
  tryBuildStaleReviewRescheduleResult,
} from "../src/agentWork/reviewReschedule.ts";
import type { ReviewWorkItem } from "../src/agentWork/types.ts";
import { makeReviewWorkItem } from "./helpers/agentWorkItems.ts";

const mocks = vi.hoisted(() => ({
  lockPrActorLeaseForUpdate: vi.fn(),
  acquireAutoWorkIntakeLock: vi.fn(),
  loadReviewLifecycle: vi.fn(),
}));

vi.mock("../src/agentWork/workItemStateRepository.ts", () => ({
  getWorkItem: vi.fn(),
  markQueuedWorkCancelled: vi.fn(),
}));
vi.mock("../src/agentWork/prActorLease.ts", () => ({
  lockPrActorLeaseForUpdate: mocks.lockPrActorLeaseForUpdate,
}));
vi.mock("../src/agentWork/autoWorkEnqueue.ts", () => ({
  acquireAutoWorkIntakeLock: mocks.acquireAutoWorkIntakeLock,
}));
vi.mock("../src/agentWork/intake/workItemRepository.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/agentWork/intake/workItemRepository.ts")>()),
  loadReviewLifecycle: mocks.loadReviewLifecycle,
}));
vi.mock("../src/db/postgres.ts", () => ({
  inTransaction: async (
    pool: Pool,
    fn: (client: PoolClient) => Promise<unknown>,
  ): Promise<unknown> => fn(pool as unknown as PoolClient),
  pgBossDb: (client: PoolClient) => ({
    executeSql: (text: string, values?: unknown[]) => client.query(text, values),
  }),
}));
vi.mock("../src/evlog.ts", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { getWorkItem, markQueuedWorkCancelled } from "../src/agentWork/workItemStateRepository.ts";
import * as evlog from "../src/evlog.ts";

const LEASE_EPOCH = 7;

function fakePool(query: ReturnType<typeof vi.fn> = vi.fn()): Pool {
  return { query } as unknown as Pool;
}

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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lockPrActorLeaseForUpdate.mockResolvedValue(undefined);
  mocks.acquireAutoWorkIntakeLock.mockResolvedValue(undefined);
  mocks.loadReviewLifecycle.mockResolvedValue(undefined);
});

describe("createReviewRescheduleWorkItem", () => {
  it("rejects a stale lease epoch before marker persistence", async () => {
    const leaseLost = new AppError({
      domain: "agent_work",
      kind: "pr_actor_lease_lost",
      message: "PR actor lease is no longer held by this execution",
    });
    mocks.lockPrActorLeaseForUpdate.mockRejectedValue(leaseLost);
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{ id: "parent-wi", head_sha: DEFERRED_HEAD_SHA }],
    });
    const pool = fakePool(query);
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
    const pool = fakePool(query);

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
    const pool = fakePool(query);

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
    const pool = fakePool(query);

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
    const pool = fakePool(query);

    await expect(
      createReviewRescheduleWorkItem(pool, makeItem(), LEASE_EPOCH),
    ).rejects.toMatchObject({
      code: "agent_work.stale_head_parent_not_reschedulable",
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("preserves auto source on the replacement work item and ack", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "parent-wi" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ head_sha: DEFERRED_HEAD_SHA }] })
      .mockResolvedValue({ rowCount: 1, rows: [] });
    const pool = fakePool(query);
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
    const pool = fakePool(query);

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
    const pool = fakePool(query);
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
    const pool = fakePool(query);

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
    const pool = fakePool(query);

    const result = await tryBuildStaleReviewRescheduleResult(pool, makeItem(), LEASE_EPOCH);
    expect(result).toMatchObject({
      kind: "rescheduled",
      replacementWorkItemId: "generated-replacement",
    });
    expect(typeof result?.afterComplete).toBe("function");
  });

  it("staleHeadReplacementExhaustedError uses the shared exhausted code", () => {
    const error = staleHeadReplacementExhaustedError(makeItem());
    expect(error.code).toBe("review.stale_head_replacement_exhausted");
    expect(error.message).toMatch(/\/review/);
    expect(isStaleHeadReplacementExhausted(error)).toBe(true);
    expect(isStaleHeadReplacementExhausted(new Error("other"))).toBe(false);
  });
});

describe("enqueueReviewReschedule", () => {
  it("rejects a stale lease epoch before deterministic enqueue", async () => {
    const leaseLost = new AppError({
      domain: "agent_work",
      kind: "pr_actor_lease_lost",
      message: "PR actor lease is no longer held by this execution",
    });
    mocks.lockPrActorLeaseForUpdate.mockRejectedValue(leaseLost);
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    const pool = fakePool(query);
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
    const pool = fakePool(query);
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
    const pool = fakePool(query);
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
    const pool = fakePool(query);
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
    const pool = fakePool(query);
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
    const pool = fakePool(query);
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
    const pool = fakePool(query);
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
    const pool = fakePool(query);
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
    const pool = fakePool(query);
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

describe("cancelPendingStaleHeadReplacement", () => {
  const pool = {} as Pool;

  function persistParent(
    replacement?: ReturnType<typeof pendingReplacement> | ReturnType<typeof enqueuedReplacement>,
  ) {
    vi.mocked(getWorkItem).mockResolvedValue(
      makeItem({ payload: { mode: "review", source: "slash", ...replacement } }),
    );
  }

  it("cancels a pending-enqueue replacement named by the persisted parent", async () => {
    vi.mocked(markQueuedWorkCancelled).mockResolvedValue(true);
    const boom = new Error("terminal before enqueue");
    persistParent(pendingReplacement("replacement-wi"));

    await cancelPendingStaleHeadReplacement(pool, makeItem(), boom);

    expect(getWorkItem).toHaveBeenCalledWith(pool, "parent-wi");
    expect(markQueuedWorkCancelled).toHaveBeenCalledWith(pool, "replacement-wi", boom);
  });

  it("no-ops without a replacement marker or parent row", async () => {
    persistParent();
    await cancelPendingStaleHeadReplacement(pool, makeItem(), new Error("dead"));
    vi.mocked(getWorkItem).mockResolvedValue(null);
    await cancelPendingStaleHeadReplacement(pool, makeItem(), new Error("dead"));

    expect(markQueuedWorkCancelled).not.toHaveBeenCalled();
    expect(evlog.logError).not.toHaveBeenCalled();
  });

  it("keeps a replacement whose enqueue committed, whatever the hook snapshot says", async () => {
    persistParent(enqueuedReplacement("replacement-wi"));

    await cancelPendingStaleHeadReplacement(
      pool,
      makeItem({
        payload: { mode: "review", source: "slash", ...pendingReplacement("replacement-wi") },
      }),
      new Error("dead"),
    );

    expect(markQueuedWorkCancelled).not.toHaveBeenCalled();
  });

  it("cancels pending replacement work despite a live review delivery (#662)", async () => {
    vi.mocked(markQueuedWorkCancelled).mockResolvedValue(true);
    persistParent(pendingReplacement("replacement-wi"));

    await cancelPendingStaleHeadReplacement(pool, makeItem(), new Error("parent failed"));

    expect(markQueuedWorkCancelled).toHaveBeenCalledWith(pool, "replacement-wi", expect.any(Error));
  });

  it("rejects and signals an error when replacement cancellation misses (#661)", async () => {
    vi.mocked(markQueuedWorkCancelled).mockResolvedValue(false);
    persistParent(pendingReplacement("replacement-wi"));

    await expect(
      cancelPendingStaleHeadReplacement(pool, makeItem(), new Error("enqueue failed")),
    ).rejects.toMatchObject({ code: "agent_work.replacement_cancel_rejected" });

    expect(evlog.logError).toHaveBeenCalledWith(
      "agent_work_replacement_cancel_failed",
      expect.objectContaining({
        type: "review",
        workItemId: "parent-wi",
        replacementWorkItemId: "replacement-wi",
      }),
      expect.any(AppError),
    );
    expect(evlog.logWarn).not.toHaveBeenCalled();
  });

  it("signals and propagates a sanitized cancellation error (#661)", async () => {
    const failure = new Error("db down token=synthetic-secret");
    vi.mocked(markQueuedWorkCancelled).mockRejectedValue(failure);
    persistParent(pendingReplacement("replacement-wi"));

    await expect(
      cancelPendingStaleHeadReplacement(pool, makeItem(), new Error("enqueue failed")),
    ).rejects.toBe(failure);

    expect(evlog.logError).toHaveBeenCalledWith(
      "agent_work_replacement_cancel_failed",
      expect.objectContaining({
        type: "review",
        workItemId: "parent-wi",
        replacementWorkItemId: "replacement-wi",
        message: "db down [redacted]",
      }),
      failure,
    );
    expect(evlog.logWarn).not.toHaveBeenCalled();
  });

  it("signals an unreadable parent instead of silently keeping the replacement", async () => {
    const failure = new Error("db down");
    vi.mocked(getWorkItem).mockRejectedValue(failure);

    await expect(
      cancelPendingStaleHeadReplacement(pool, makeItem(), new Error("dead")),
    ).rejects.toBe(failure);

    expect(evlog.logError).toHaveBeenCalledWith(
      "agent_work_replacement_cancel_failed",
      expect.objectContaining({ workItemId: "parent-wi", replacementWorkItemId: undefined }),
      failure,
    );
    expect(markQueuedWorkCancelled).not.toHaveBeenCalled();
  });
});

describe("schedulePushFollowUp", () => {
  const boundHeadSha = "bound-head";

  function parent(payload: Record<string, unknown> = {}) {
    return makeItem({
      source: "slash",
      payload: { mode: "review", source: "slash", ...payload },
    });
  }

  async function schedule(
    item: ReturnType<typeof parent>,
    pool: Pool,
    overrides: Partial<{
      reviewCadence: "once" | "every_push";
      boundHeadSha: string;
      leaseEpoch: number | null;
      pullRequestClosed: boolean;
      liveHeadSha: string;
    }> = {},
  ) {
    const calls: string[] = [];
    const prSurface = {
      getHeadSha: vi.fn(async () => {
        calls.push("head");
        return overrides.liveHeadSha ?? "new-head";
      }),
    };
    mocks.acquireAutoWorkIntakeLock.mockImplementation(async () => {
      calls.push("lock");
    });
    const result = await schedulePushFollowUp({
      pool,
      item,
      payload: item.payload,
      reviewCadence: overrides.reviewCadence ?? "every_push",
      prSurface,
      boundHeadSha: overrides.boundHeadSha ?? boundHeadSha,
      leaseEpoch: overrides.leaseEpoch === undefined ? LEASE_EPOCH : overrides.leaseEpoch,
      pullRequestClosed: overrides.pullRequestClosed ?? false,
    });
    return { result, calls, prSurface };
  }

  it("returns the original skip for once, auto source, a stale replacement, a closed pull request, an equal head, and a missing lease", async () => {
    const pool = fakePool();
    const slash = parent();
    await expect(schedule(slash, pool, { reviewCadence: "once" })).resolves.toMatchObject({
      result: null,
      calls: [],
    });
    await expect(schedule(parent({ source: "auto" }), pool)).resolves.toMatchObject({
      result: null,
      calls: [],
    });
    await expect(
      schedule(
        parent({ staleHeadReplacement: { replacementWorkItemId: "r", state: "pending-enqueue" } }),
        pool,
      ),
    ).resolves.toMatchObject({ result: null, calls: [] });
    await expect(schedule(slash, pool, { pullRequestClosed: true })).resolves.toMatchObject({
      result: null,
      calls: [],
    });
    await expect(schedule(slash, pool, { leaseEpoch: null })).resolves.toMatchObject({
      result: null,
      calls: [],
    });
    await expect(schedule(slash, pool, { liveHeadSha: boundHeadSha })).resolves.toMatchObject({
      result: null,
      calls: ["head"],
    });
    expect(mocks.acquireAutoWorkIntakeLock).not.toHaveBeenCalled();
  });

  it("stores an automatic deferred-head child and reads the live head before the intake lock", async () => {
    const followUp = { webhookEventId: "evt-1" };
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ payload: { mode: "review", source: "slash", pushFollowUp: followUp } }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ replacement_id: "child-1" }] })
      .mockResolvedValue({ rowCount: 1, rows: [] });
    const pool = fakePool(query);
    const { result, calls } = await schedule(parent(), pool);

    expect(result).toMatchObject({ kind: "rescheduled", replacementWorkItemId: "child-1" });
    expect(calls).toEqual(["head", "lock"]);
    const insert = query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO agent_work_items"),
    );
    const params = insert?.[1];
    expect(params?.[0]).toEqual(expect.any(String));
    expect(params?.[1]).toBe("evt-1");
    expect(params?.[6]).toBe(DEFERRED_HEAD_SHA);
    const stored = JSON.parse(String(params?.[9]));
    expect(stored).toMatchObject({ source: "auto", mode: "review" });
    expect(stored.pushFollowUp).toBeUndefined();
    expect(stored.staleHeadRescheduled).toBeUndefined();
    expect(stored.staleHeadReplacement).toBeUndefined();
  });

  it("reuses the child id already stored on the marker", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            payload: {
              mode: "review",
              source: "slash",
              pushFollowUp: {
                webhookEventId: "evt-1",
                replacementWorkItemId: "child-kept",
                state: "pending-enqueue",
              },
            },
          },
        ],
      })
      .mockResolvedValue({ rowCount: 1, rows: [] });
    const pool = fakePool(query);
    const { result } = await schedule(parent(), pool);
    expect(result).toMatchObject({ kind: "rescheduled", replacementWorkItemId: "child-kept" });
    const insert = query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO agent_work_items"),
    );
    expect(insert?.[1]?.[0]).toBe("child-kept");
  });

  it("returns no child when the parent is no longer running", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    const pool = fakePool(query);
    const { result } = await schedule(parent(), pool);
    expect(result).toBeNull();
  });

  it("returns no child when the pull request is closed under the intake lock", async () => {
    mocks.loadReviewLifecycle.mockResolvedValue({ state: "closed" });
    const query = vi.fn();
    const pool = fakePool(query);
    const { result, calls } = await schedule(parent(), pool);
    expect(result).toBeNull();
    expect(calls).toEqual(["head", "lock"]);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("cancelPendingPushFollowUp", () => {
  const pool = fakePool();

  it("cancels a pending-enqueue follow-up and keeps an enqueued one", async () => {
    vi.mocked(markQueuedWorkCancelled).mockResolvedValue(true);
    vi.mocked(getWorkItem).mockResolvedValue(
      makeItem({
        payload: {
          mode: "review",
          source: "slash",
          pushFollowUp: {
            webhookEventId: "evt-1",
            replacementWorkItemId: "child-1",
            state: "pending-enqueue",
          },
        },
      }),
    );
    const boom = new Error("terminal");
    await cancelPendingPushFollowUp(pool, makeItem(), boom);
    expect(markQueuedWorkCancelled).toHaveBeenCalledWith(pool, "child-1", boom);

    vi.mocked(markQueuedWorkCancelled).mockClear();
    vi.mocked(getWorkItem).mockResolvedValue(
      makeItem({
        payload: {
          mode: "review",
          source: "slash",
          pushFollowUp: {
            webhookEventId: "evt-1",
            replacementWorkItemId: "child-1",
            state: "enqueued",
          },
        },
      }),
    );
    await cancelPendingPushFollowUp(pool, makeItem(), boom);
    expect(markQueuedWorkCancelled).not.toHaveBeenCalled();
  });
});
