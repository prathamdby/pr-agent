import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { ACK_QUEUE, REVIEW_QUEUE } from "../src/settings/index.js";
import {
  buildStaleSlashReviewRescheduleResult,
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
  it("skips boss.send when parent already has enqueue marker", async () => {
    const query = vi.fn();
    const pool = { query } as unknown as Pool;
    const send = vi.fn();
    const findJobs = vi.fn();
    const boss = { send, findJobs } as unknown as PgBoss;

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

    expect(send).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
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
  });

  it("claims enqueue marker before boss.send and releases it on review enqueue failure", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const pool = { query } as unknown as Pool;
    const send = vi.fn().mockResolvedValue(null);
    const findJobs = vi.fn().mockResolvedValue([]);
    const cancel = vi.fn();
    const boss = { send, findJobs, cancel } as unknown as PgBoss;

    await expect(
      enqueueSlashReviewReschedule(pool, boss, makeItem(), "replacement-wi", "newhead"),
    ).rejects.toThrow(/did not enqueue replacement review job/);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBe(REVIEW_QUEUE);
    expect(String(query.mock.calls[0]?.[0])).toContain("staleHeadReplacementEnqueued");
    expect(String(query.mock.calls[1]?.[0])).toContain("payload - 'staleHeadReplacementEnqueued'");
  });

  it("does not send an ack when replacement review enqueue throws", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
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
    expect(String(query.mock.calls[1]?.[0])).toContain("payload - 'staleHeadReplacementEnqueued'");
  });
});

describe("cancelUnenqueuedStaleHeadReplacement", () => {
  it("cancels a queued replacement when not yet enqueued", async () => {
    vi.mocked(markQueuedWorkCancelled).mockResolvedValue(true);
    const boom = new Error("enqueue failed");
    const pool = {} as Pool;

    await cancelUnenqueuedStaleHeadReplacement(pool, "parent-wi", "replacement-wi", boom, false);

    expect(markQueuedWorkCancelled).toHaveBeenCalledWith(pool, "replacement-wi", boom);
  });

  it("skips cancel when replacement was already enqueued", async () => {
    const pool = {} as Pool;

    await cancelUnenqueuedStaleHeadReplacement(
      pool,
      "parent-wi",
      "replacement-wi",
      new Error("dead"),
      true,
    );

    expect(markQueuedWorkCancelled).not.toHaveBeenCalled();
  });

  it("warns when queued replacement cancel races or misses", async () => {
    vi.mocked(markQueuedWorkCancelled).mockResolvedValue(false);
    const pool = {} as Pool;

    await cancelUnenqueuedStaleHeadReplacement(
      pool,
      "parent-wi",
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

    await expect(
      cancelUnenqueuedStaleHeadReplacement(
        pool,
        "parent-wi",
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
    await result.onRescheduleAbort(boom);

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
    await result.onRescheduleAbort(new Error("should not cancel"));

    expect(markQueuedWorkCancelled).not.toHaveBeenCalled();
  });

  it("does not cancel when parent payload already had enqueue marker", async () => {
    vi.mocked(getPullRequestHeadSha).mockResolvedValue("latest-head");
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{ head_sha: "latest-head" }],
    });
    const pool = { query } as unknown as Pool;

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
    await result.onRescheduleAbort(new Error("parent failed"));

    expect(markQueuedWorkCancelled).not.toHaveBeenCalled();
  });
});
