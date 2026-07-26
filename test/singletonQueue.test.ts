import { describe, expect, it, vi } from "vitest";
import type { PgBoss } from "pg-boss";
import {
  releaseReviewSingletonSlot,
  releaseSingletonSlot,
} from "../src/agentWork/singletonQueue.js";
import { REVIEW_QUEUE } from "../src/settings/index.js";

type JobStub = {
  id: string;
  state: string;
  data: { workItemId?: string };
};

function makeBoss(jobs: JobStub[]) {
  const findJobs = vi.fn(async () => jobs);
  const cancel = vi.fn(async () => ({ rows: [] }));
  const deleteJob = vi.fn(async () => ({ rows: [] }));
  return {
    boss: { findJobs, cancel, deleteJob } as unknown as PgBoss,
    findJobs,
    cancel,
    deleteJob,
  };
}

describe("releaseSingletonSlot", () => {
  it("deletes failed jobs so key_strict_fifo can unblock", async () => {
    const { boss, cancel, deleteJob } = makeBoss([
      { id: "failed-1", state: "failed", data: { workItemId: "wi-old" } },
      { id: "done-1", state: "completed", data: { workItemId: "wi-done" } },
    ]);

    await releaseSingletonSlot(boss, {
      queue: REVIEW_QUEUE,
      singletonKey: "owner/repo#1:review",
    });

    expect(deleteJob).toHaveBeenCalledWith(REVIEW_QUEUE, "failed-1", undefined);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("cancels created/active jobs by default and deletes failed", async () => {
    const { boss, cancel, deleteJob } = makeBoss([
      { id: "created-1", state: "created", data: { workItemId: "wi-a" } },
      { id: "active-1", state: "active", data: { workItemId: "wi-b" } },
      { id: "failed-1", state: "failed", data: { workItemId: "wi-c" } },
      { id: "cancelled-1", state: "cancelled", data: { workItemId: "wi-d" } },
    ]);

    await releaseSingletonSlot(boss, {
      queue: REVIEW_QUEUE,
      singletonKey: "owner/repo#1:review",
    });

    expect(cancel).toHaveBeenCalledWith(REVIEW_QUEUE, "created-1", undefined);
    expect(cancel).toHaveBeenCalledWith(REVIEW_QUEUE, "active-1", undefined);
    expect(deleteJob).toHaveBeenCalledWith(REVIEW_QUEUE, "failed-1", undefined);
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it("with cancelNonTerminal:false only deletes failed jobs", async () => {
    const { boss, cancel, deleteJob } = makeBoss([
      { id: "created-1", state: "created", data: { workItemId: "wi-a" } },
      { id: "failed-1", state: "failed", data: { workItemId: "wi-b" } },
    ]);

    await releaseSingletonSlot(boss, {
      queue: REVIEW_QUEUE,
      singletonKey: "owner/repo#1:review",
      cancelNonTerminal: false,
    });

    expect(deleteJob).toHaveBeenCalledWith(REVIEW_QUEUE, "failed-1", undefined);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("respects skipJobId and skipWorkItemId", async () => {
    const { boss, cancel, deleteJob } = makeBoss([
      { id: "skip-me", state: "created", data: { workItemId: "wi-skip-job" } },
      { id: "other", state: "created", data: { workItemId: "wi-skip-item" } },
      { id: "failed-skip", state: "failed", data: { workItemId: "wi-skip-item" } },
      { id: "failed-keep", state: "failed", data: { workItemId: "wi-x" } },
    ]);

    await releaseSingletonSlot(boss, {
      queue: REVIEW_QUEUE,
      singletonKey: "owner/repo#1:review",
      skipJobId: "skip-me",
      skipWorkItemId: "wi-skip-item",
    });

    expect(cancel).not.toHaveBeenCalled();
    expect(deleteJob).toHaveBeenCalledTimes(1);
    expect(deleteJob).toHaveBeenCalledWith(REVIEW_QUEUE, "failed-keep", undefined);
  });

  it("releaseReviewSingletonSlot targets the review queue key", async () => {
    const { boss, findJobs, deleteJob } = makeBoss([
      { id: "failed-1", state: "failed", data: { workItemId: "wi-old" } },
    ]);

    await releaseReviewSingletonSlot(boss, "acme/app#7", { cancelNonTerminal: false });

    expect(findJobs).toHaveBeenCalledWith(REVIEW_QUEUE, { key: "acme/app#7:review" });
    expect(deleteJob).toHaveBeenCalledWith(REVIEW_QUEUE, "failed-1", undefined);
  });
});
