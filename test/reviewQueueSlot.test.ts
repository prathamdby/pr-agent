import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import {
  reapReviewQueueOrphans,
  releaseReviewQueueSlot,
} from "../src/agentWork/reviewQueueSlot.js";
import { ACTIVE_WORK_STATUSES } from "../src/agentWork/types.js";
import { initEvlog } from "../src/evlog.js";
import { REVIEW_QUEUE, STRANDED_WORK_REAPER_GRACE_SECONDS } from "../src/settings/index.js";

const analyticsMocks = vi.hoisted(() => ({
  captureEvent: vi.fn(),
}));

vi.mock("../src/analytics/index.js", () => ({
  captureEvent: analyticsMocks.captureEvent,
  captureException: vi.fn(),
}));

const logMocks = vi.hoisted(() => ({
  logWarn: vi.fn(),
}));

vi.mock("../src/evlog.js", async () => {
  const actual = await vi.importActual<typeof import("../src/evlog.js")>("../src/evlog.js");
  return {
    ...actual,
    logWarn: logMocks.logWarn,
  };
});

function activeIdPool(activeIds: readonly string[]): Pool {
  return {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      expect(sql).toContain("id::text = ANY($1::text[])");
      expect(sql).toContain("status = ANY($2::text[])");
      expect(params[1]).toEqual([...ACTIVE_WORK_STATUSES]);
      return { rows: activeIds.map((id) => ({ id })) };
    }),
  } as unknown as Pool;
}

describe("releaseReviewQueueSlot", () => {
  beforeEach(() => {
    initEvlog("info", { silent: true, suppressDrainWarning: true });
    analyticsMocks.captureEvent.mockReset();
    logMocks.logWarn.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    initEvlog("error", { silent: true, suppressDrainWarning: true });
  });

  it("releases failed blockers and inactive-work-item holders, keeps live queued jobs", async () => {
    const findJobs = vi.fn(async () => [
      { id: "failed-1", state: "failed", data: { workItemId: "wi-fail" } },
      { id: "orphan-active", state: "active", data: { workItemId: "wi-done" } },
      { id: "live-created", state: "created", data: { workItemId: "wi-live" } },
      { id: "missing-item", state: "retry", data: {} },
    ]);
    const cancel = vi.fn(async () => ({ rows: [] }));
    const deleteJob = vi.fn(async () => ({ rows: [] }));
    const boss = { findJobs, cancel, deleteJob } as unknown as PgBoss;
    const pool = activeIdPool(["wi-live"]);

    await expect(releaseReviewQueueSlot(boss, pool, "acme/app#7")).resolves.toEqual({
      released: 3,
    });

    expect(findJobs).toHaveBeenCalledWith(REVIEW_QUEUE, { key: "acme/app#7:review" });
    expect(deleteJob).toHaveBeenCalledWith(REVIEW_QUEUE, "failed-1", undefined);
    expect(cancel).toHaveBeenCalledWith(REVIEW_QUEUE, "orphan-active", undefined);
    expect(cancel).toHaveBeenCalledWith(REVIEW_QUEUE, "missing-item", undefined);
    expect(cancel).not.toHaveBeenCalledWith(REVIEW_QUEUE, "live-created", undefined);
    expect(logMocks.logWarn).toHaveBeenCalledWith(
      "review_queue_slot_released",
      expect.objectContaining({
        jobId: "orphan-active",
        reason: "inactive_work_item",
      }),
    );
    expect(logMocks.logWarn).toHaveBeenCalledWith(
      "review_queue_slot_released",
      expect.objectContaining({
        jobId: "missing-item",
        reason: "missing_work_item",
      }),
    );
  });

  it("treats deleted, non-UUID, and non-string workItemIds as orphans without uuid cast", async () => {
    const liveId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const findJobs = vi.fn(async () => [
      {
        id: "deleted-row",
        state: "created",
        data: { workItemId: "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
      },
      { id: "bad-uuid", state: "active", data: { workItemId: "not-a-uuid" } },
      { id: "non-string", state: "retry", data: { workItemId: 42 } },
      { id: "live", state: "created", data: { workItemId: liveId } },
    ]);
    const cancel = vi.fn(async () => ({ rows: [] }));
    const deleteJob = vi.fn(async () => ({ rows: [] }));
    const boss = { findJobs, cancel, deleteJob } as unknown as PgBoss;
    const query = vi.fn(async (sql: string, params: unknown[]) => {
      expect(sql).toContain("id::text = ANY($1::text[])");
      expect(sql).not.toContain("ANY($1::uuid[])");
      expect(params[0]).toEqual(["bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee", "not-a-uuid", liveId]);
      expect(params[1]).toEqual([...ACTIVE_WORK_STATUSES]);
      return { rows: [{ id: liveId }] };
    });
    const pool = { query } as unknown as Pool;

    await expect(releaseReviewQueueSlot(boss, pool, "acme/app#7")).resolves.toEqual({
      released: 3,
    });

    expect(cancel).toHaveBeenCalledWith(REVIEW_QUEUE, "deleted-row", undefined);
    expect(cancel).toHaveBeenCalledWith(REVIEW_QUEUE, "bad-uuid", undefined);
    expect(cancel).toHaveBeenCalledWith(REVIEW_QUEUE, "non-string", undefined);
    expect(cancel).not.toHaveBeenCalledWith(REVIEW_QUEUE, "live", undefined);
    expect(deleteJob).not.toHaveBeenCalled();
    expect(logMocks.logWarn).toHaveBeenCalledWith(
      "review_queue_slot_released",
      expect.objectContaining({
        jobId: "non-string",
        workItemId: null,
        reason: "missing_work_item",
      }),
    );
  });

  it("skips skipJobId and skipWorkItemId while releasing other holders", async () => {
    const findJobs = vi.fn(async () => [
      { id: "active-keep", state: "active", data: { workItemId: "wi-active" } },
      { id: "replacement", state: "created", data: { workItemId: "wi-replacement" } },
      { id: "failed-orphan", state: "failed", data: { workItemId: "wi-old" } },
    ]);
    const cancel = vi.fn(async () => ({ rows: [] }));
    const deleteJob = vi.fn(async () => ({ rows: [] }));
    const boss = { findJobs, cancel, deleteJob } as unknown as PgBoss;
    const pool = activeIdPool(["wi-active", "wi-replacement"]);

    await expect(
      releaseReviewQueueSlot(boss, pool, "acme/app#7", {
        skipJobId: "active-keep",
        skipWorkItemId: "wi-replacement",
      }),
    ).resolves.toEqual({ released: 1 });

    expect(deleteJob).toHaveBeenCalledWith(REVIEW_QUEUE, "failed-orphan", undefined);
    expect(cancel).not.toHaveBeenCalled();
    expect(deleteJob).not.toHaveBeenCalledWith(REVIEW_QUEUE, "active-keep", undefined);
    expect(deleteJob).not.toHaveBeenCalledWith(REVIEW_QUEUE, "replacement", undefined);
  });

  it("also cancels explicit cancelWorkItemIds", async () => {
    const findJobs = vi.fn(async () => [
      { id: "live-slash", state: "created", data: { workItemId: "wi-slash" } },
      { id: "other-live", state: "active", data: { workItemId: "wi-other" } },
    ]);
    const cancel = vi.fn(async () => ({ rows: [] }));
    const deleteJob = vi.fn(async () => ({ rows: [] }));
    const boss = { findJobs, cancel, deleteJob } as unknown as PgBoss;
    const pool = activeIdPool(["wi-slash", "wi-other"]);

    await releaseReviewQueueSlot(boss, pool, "acme/app#7", {
      cancelWorkItemIds: ["wi-slash"],
    });

    expect(cancel).toHaveBeenCalledWith(REVIEW_QUEUE, "live-slash", undefined);
    expect(cancel).not.toHaveBeenCalledWith(REVIEW_QUEUE, "other-live", undefined);
    expect(deleteJob).not.toHaveBeenCalled();
  });
});

describe("reapReviewQueueOrphans", () => {
  beforeEach(() => {
    initEvlog("info", { silent: true, suppressDrainWarning: true });
    analyticsMocks.captureEvent.mockReset();
    logMocks.logWarn.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    initEvlog("error", { silent: true, suppressDrainWarning: true });
  });

  it("cancels orphan holders and emits stale-queued telemetry", async () => {
    const cancel = vi.fn(async () => ({ rows: [] }));
    const deleteJob = vi.fn(async () => ({ rows: [] }));
    const boss = { cancel, deleteJob } as unknown as PgBoss;
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM pgboss.job")) {
          return {
            rows: [
              {
                job_id: "j-fail",
                singleton_key: "acme/app#1:review",
                state: "failed",
                work_item_id: "wi-old",
              },
              {
                job_id: "j-orphan",
                singleton_key: "acme/app#2:review",
                state: "active",
                work_item_id: "wi-terminal",
              },
            ],
          };
        }
        if (sql.includes("status = 'queued'")) {
          return {
            rows: [
              {
                id: "wi-stale",
                resource_key: "acme/app#9",
                age_seconds: STRANDED_WORK_REAPER_GRACE_SECONDS + 30,
              },
            ],
          };
        }
        throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
      }),
    } as unknown as Pool;

    await expect(reapReviewQueueOrphans(boss, pool)).resolves.toEqual({
      released: 2,
      staleQueuedLogged: 1,
    });

    expect(deleteJob).toHaveBeenCalledWith(REVIEW_QUEUE, "j-fail");
    expect(cancel).toHaveBeenCalledWith(REVIEW_QUEUE, "j-orphan");
    expect(logMocks.logWarn).toHaveBeenCalledWith(
      "review_queued_stale",
      expect.objectContaining({
        workItemId: "wi-stale",
        resourceKey: "acme/app#9",
      }),
    );
    expect(analyticsMocks.captureEvent).toHaveBeenCalledWith({
      distinctId: "server",
      event: "review queued stale",
      properties: expect.objectContaining({
        work_item_id: "wi-stale",
        resource_key: "acme/app#9",
      }),
    });
  });
});
