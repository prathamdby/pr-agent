import { afterEach, describe, expect, it } from "vitest";
import { reviewQueuePosition } from "../src/state/featurePublication.ts";
import {
  claimDispatchableWorkRun,
  insertWorkRun,
  markAttemptRunning,
  markWorkRunCompleted,
} from "../src/state/workRuns.ts";
import { openSqliteAppState } from "./integration/db.ts";

describe("reviewQueuePosition", () => {
  const handles: Array<{ close: () => void }> = [];

  function openDb() {
    const handle = openSqliteAppState();
    handles.push(handle);
    return handle.db;
  }

  afterEach(() => {
    while (handles.length > 0) handles.pop()?.close();
  });

  function enqueueReview(
    db: ReturnType<typeof openDb>,
    workId: string,
    prNumber: number,
    createdAt: number,
  ) {
    insertWorkRun(db, {
      workId,
      prKey: `acme/app#${prNumber}`,
      kind: "review",
      laneEpoch: 0,
      payloadJson: JSON.stringify({
        installationId: 1,
        owner: "acme",
        repo: "app",
        prNumber,
        headSha: "a".repeat(40),
      }),
      now: createdAt,
    });
  }

  it("returns #1 of 1 for a sole queued review", () => {
    const db = openDb();
    enqueueReview(db, "wi-only", 1, 100);
    expect(reviewQueuePosition(db, "wi-only")).toEqual({ position: 1, total: 1 });
  });

  it("returns FIFO rank across pending reviews", () => {
    const db = openDb();
    enqueueReview(db, "wi-1", 1, 100);
    enqueueReview(db, "wi-2", 1, 200);
    enqueueReview(db, "wi-3", 1, 300);
    expect(reviewQueuePosition(db, "wi-2")).toEqual({ position: 2, total: 3 });
  });

  it("returns null when the work item is terminal or missing", () => {
    const db = openDb();
    db.prepare(
      `INSERT INTO pr_state (pr_key, lifecycle_state, observed_at, updated_at) VALUES ('acme/app#1', 'open', 100, 100)`,
    ).run();
    enqueueReview(db, "wi-done", 1, 100);
    const claimed = claimDispatchableWorkRun(db, 150, { kinds: ["review"] });
    if (!claimed) throw new Error("expected claimed work run");
    expect(claimed.run.work_id).toBe("wi-done");
    markAttemptRunning(db, {
      workId: "wi-done",
      attemptNo: claimed.attempt.attempt_no,
      conversationId: "conv-1",
      taskId: "task-1",
      now: 160,
    });
    markWorkRunCompleted(db, {
      workId: "wi-done",
      attemptNo: claimed.attempt.attempt_no,
      now: 200,
    });
    expect(reviewQueuePosition(db, "wi-done")).toBeNull();
    expect(reviewQueuePosition(db, "wi-missing")).toBeNull();
  });
});
