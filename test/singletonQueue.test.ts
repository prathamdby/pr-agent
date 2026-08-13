import { describe, expect, it, vi } from "vitest";
import { releaseSingletonSlot } from "../src/agentWork/singletonQueue.js";
import { DESCRIPTION_QUEUE, REVIEW_QUEUE } from "../src/settings/index.js";
import { createJobQueue } from "./helpers/recordingBoss.js";
import type { QueueJob } from "../src/agentWork/intake/queueing.js";

function makeBoss(jobs: QueueJob[]) {
  const findJobs = vi.fn(async () => jobs);
  const cancel = vi.fn(async () => ({ rows: [] }));
  const deleteJob = vi.fn(async () => ({ rows: [] }));
  return {
    boss: createJobQueue({ findJobs, cancel, deleteJob }),
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
      queue: DESCRIPTION_QUEUE,
      singletonKey: "owner/repo#1:description",
    });

    expect(deleteJob).toHaveBeenCalledWith(DESCRIPTION_QUEUE, "failed-1", undefined);
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

  it("with cancelWorkItemIds only cancels listed non-terminal jobs", async () => {
    const { boss, cancel, deleteJob } = makeBoss([
      { id: "auto-old", state: "created", data: { workItemId: "wi-auto" } },
      { id: "slash-live", state: "active", data: { workItemId: "wi-slash" } },
      { id: "failed-1", state: "failed", data: { workItemId: "wi-fail" } },
      { id: "orphan", state: "created", data: {} },
    ]);

    await releaseSingletonSlot(boss, {
      queue: REVIEW_QUEUE,
      singletonKey: "owner/repo#1:review",
      cancelNonTerminal: true,
      cancelWorkItemIds: ["wi-auto"],
    });

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith(REVIEW_QUEUE, "auto-old", undefined);
    expect(deleteJob).toHaveBeenCalledWith(REVIEW_QUEUE, "failed-1", undefined);
  });
});
