import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { ACK_QUEUE, REVIEW_QUEUE } from "../src/settings/index.js";
import {
  buildStaleReviewRescheduleResult,
  createStaleReviewRescheduleWorkItem,
  enqueueStaleReviewReschedule,
} from "../src/agentWork/reviewReschedule.js";
import type { AgentWorkItem } from "../src/agentWork/types.js";

vi.mock("../src/agentWork/repository.js", () => ({
  getWorkItem: vi.fn(),
}));
vi.mock("../src/agentWork/githubPrSurface.js", () => ({
  getPullRequestHeadSha: vi.fn(),
}));

import { getWorkItem } from "../src/agentWork/repository.js";
import { getPullRequestHeadSha } from "../src/agentWork/githubPrSurface.js";

function makeItem(overrides: Partial<AgentWorkItem> = {}): AgentWorkItem {
  return {
    id: "parent-wi",
    webhookEventId: "ev-1",
    type: "review",
    source: "slash",
    status: "running",
    owner: "o",
    repo: "r",
    prNumber: 1,
    installationId: 42,
    headSha: "deadbeef",
    reviewLens: "review",
    resourceKey: "o/r#1",
    attemptCount: 1,
    payload: { mode: "review", source: "slash" },
    cancelRequestedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createStaleReviewRescheduleWorkItem", () => {
  it("keeps the first persisted head_sha when replacement row already exists", async () => {
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{ head_sha: "persisted-head" }],
    });
    const pool = { query } as unknown as Pool;

    const replacement = await createStaleReviewRescheduleWorkItem(
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

    const replacement = await createStaleReviewRescheduleWorkItem(
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

    const replacement = await createStaleReviewRescheduleWorkItem(pool, makeItem(), "newhead");

    expect(replacement.replacementWorkItemId).toBe("generated-replacement");
    expect(query).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[0]?.[0])).toContain(
      "payload->>'staleHeadReplacementWorkItemId') IS NULL",
    );
    expect(query.mock.calls[1]?.[1]).toEqual(
      expect.arrayContaining(["generated-replacement", "ev-1", "slash"]),
    );
  });

  it("preserves auto source on the replacement work item and ack", async () => {
    vi.mocked(getPullRequestHeadSha).mockResolvedValue("latest-head");
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ replacement_id: "auto-replacement" }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ head_sha: "latest-head" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const pool = { query } as unknown as Pool;
    const send = vi.fn().mockResolvedValue("job-id");
    const findJobs = vi.fn().mockResolvedValue([]);
    const cancel = vi.fn();
    const boss = { send, findJobs, cancel } as unknown as PgBoss;
    const autoItem = makeItem({
      source: "auto",
      payload: { mode: "review", source: "auto" },
    });

    const result = await buildStaleReviewRescheduleResult(pool, autoItem, "token");
    await result.afterComplete(boss, "active-job");

    expect(query.mock.calls[1]?.[1]).toEqual(
      expect.arrayContaining(["auto-replacement", "ev-1", "auto"]),
    );
    const ackCall = send.mock.calls.find(([queue]) => queue === ACK_QUEUE);
    expect(ackCall?.[1]).toMatchObject({
      progress: { headSha: "latest-head", source: "auto" },
    });
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

    const replacement = await createStaleReviewRescheduleWorkItem(pool, makeItem(), "newhead");

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

    const result = await buildStaleReviewRescheduleResult(
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

describe("enqueueStaleReviewReschedule", () => {
  it("skips boss.send when parent already has enqueue marker", async () => {
    const query = vi.fn();
    const pool = { query } as unknown as Pool;
    const send = vi.fn();
    const findJobs = vi.fn();
    const boss = { send, findJobs } as unknown as PgBoss;

    await enqueueStaleReviewReschedule(
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

    await enqueueStaleReviewReschedule(pool, boss, makeItem(), "replacement-wi", "newhead");

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
      enqueueStaleReviewReschedule(pool, boss, makeItem(), "replacement-wi", "newhead"),
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
      enqueueStaleReviewReschedule(pool, boss, makeItem(), "replacement-wi", "newhead"),
    ).rejects.toThrow(/review queue unavailable/);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBe(REVIEW_QUEUE);
    expect(String(query.mock.calls[1]?.[0])).toContain("payload - 'staleHeadReplacementEnqueued'");
  });
});
