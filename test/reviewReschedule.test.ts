import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { ACK_QUEUE, REVIEW_QUEUE } from "../src/settings/index.js";
import {
  buildStaleSlashReviewRescheduleResult,
  createSlashReviewRescheduleWorkItem,
  enqueueSlashReviewReschedule,
} from "../src/agentWork/reviewReschedule.js";
import type { ReviewWorkItem } from "../src/agentWork/types.js";
import { makeReviewWorkItem } from "./helpers/agentWorkItems.js";

vi.mock("../src/agentWork/repository.js", () => ({
  getWorkItem: vi.fn(),
}));
vi.mock("../src/agentWork/githubPrSurface.js", () => ({
  getPullRequestHeadSha: vi.fn(),
}));

import { getWorkItem } from "../src/agentWork/repository.js";
import { getPullRequestHeadSha } from "../src/agentWork/githubPrSurface.js";

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
