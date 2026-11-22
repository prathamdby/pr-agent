import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as v from "valibot";
import { prResourceKey } from "../../src/agentWork/types.ts";
import * as evlog from "../../src/evlog.ts";
import { isKnownNoAcceptanceMutationError } from "../../src/github/mutationErrorContract.ts";
import { createFakePrSurface } from "../../src/github/prSurface.ts";
import { createReviewSummaryComment } from "../../src/review/publish/reviewSummaryComment.ts";
import { REVIEW_SUMMARY_SENTINEL } from "../../src/review/reviewSchema.ts";
import {
  approvalNoticePublishable,
  createFeaturePublication,
  inlineReviewLensesForPr,
  latestPublishStepWithoutNewer,
  progressCommentOwner,
  recordPublishStep,
  reviewQueuePosition,
  workRunCurrent,
} from "../../src/state/featurePublication.ts";
import { ensurePrState } from "../../src/state/intake.ts";
import { withPrMutex } from "../../src/state/prMutex.ts";
import { publishOnce, sharedPublishRecord } from "../../src/state/publish.ts";
import {
  attemptFor,
  bumpLaneEpoch,
  cancelWorkRun,
  claimDispatchableWorkRun,
  insertWorkRun,
  markAttemptRunning,
  markWorkRunCompleted,
  markWorkRunFailed,
  nextRetryAtMs,
  scheduleWorkRunRetry,
  supersedeWorkRun,
  workRunById,
} from "../../src/state/workRuns.ts";
import { openSqliteAppState } from "./db.ts";

const OWNER = "work-item-repo-it";
const REPO = "app";

describe("work runs, summary comment coordination, and publish records on SQLite (integration)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { scenario: "older first", first: 2 as const, second: 3 as const, seeded: true },
    { scenario: "newer first", first: 3 as const, second: 2 as const, seeded: true },
    { scenario: "equal revisions", first: 2 as const, second: 2 as const, seeded: true },
    { scenario: "absent comment", first: 2 as const, second: 3 as const, seeded: false },
  ])(
    "serializes summary progress ticks and preserves monotonic revisions ($scenario)",
    async ({ first, second, seeded }) => {
      const state = openSqliteAppState();
      try {
        const now = Date.now();
        const prKey = prResourceKey(OWNER, REPO, 19);
        const workId = randomUUID();
        ensurePrState(state.db, prKey, now);
        insertWorkRun(state.db, {
          workId,
          prKey,
          kind: "review",
          payloadJson: JSON.stringify({ headSha: "sha-head" }),
          now,
        });
        const fake = createFakePrSurface({ owner: OWNER, repo: REPO, prNumber: 19 });
        const summary = createReviewSummaryComment({
          prSurface: fake.surface,
          reviewLens: "review",
          coordination: { db: state.db, resourceKey: prKey, workItemId: workId },
        });

        if (seeded) {
          await withPrMutex(prKey, () =>
            summary.tick({
              body: `${REVIEW_SUMMARY_SENTINEL}\nrev-1`,
              progressRevision: 1,
            }),
          );
        }
        const initialCommentId = fake.controls.getProgressComment(REVIEW_SUMMARY_SENTINEL)?.id;

        await Promise.all([
          withPrMutex(prKey, () =>
            summary.tick({
              body: `${REVIEW_SUMMARY_SENTINEL}\nrev-${first}`,
              progressRevision: first,
            }),
          ),
          withPrMutex(prKey, () =>
            summary.tick({
              body: `${REVIEW_SUMMARY_SENTINEL}\nrev-${second}`,
              progressRevision: second,
            }),
          ),
        ]);

        const expectedRevision = Math.max(first, second);
        const comment = fake.controls.getProgressComment(REVIEW_SUMMARY_SENTINEL);
        if (seeded) expect(comment?.id).toBe(initialCommentId);
        expect(comment?.id).toBeGreaterThan(0);
        expect(comment?.body).toContain(`rev-${expectedRevision}`);
        expect(comment?.body).toContain(`workItemId=${workId} value=${expectedRevision}`);

        const stored = sharedPublishRecord(state.db, prKey, "review", "progress_comment");
        expect(stored?.workId).toBe(workId);
        expect(stored?.detail.progressRevision).toBe(expectedRevision);
        expect(stored?.githubId).toBe(comment?.id);
      } finally {
        state.close();
      }
    },
  );

  it("skips summary writes for foreign owners and respects shouldPublish gate", async () => {
    const state = openSqliteAppState();
    try {
      const now = Date.now();
      const prKey = prResourceKey(OWNER, REPO, 20);
      const ownerWorkId = randomUUID();
      const foreignWorkId = randomUUID();
      ensurePrState(state.db, prKey, now);
      insertWorkRun(state.db, {
        workId: ownerWorkId,
        prKey,
        kind: "review",
        payloadJson: "{}",
        now,
      });
      insertWorkRun(state.db, {
        workId: foreignWorkId,
        prKey,
        kind: "review",
        payloadJson: "{}",
        now: now + 1,
      });

      const fake = createFakePrSurface({ owner: OWNER, repo: REPO, prNumber: 20 });
      const warn = vi.spyOn(evlog, "logWarn").mockImplementation(() => {});

      const ownerSummary = createReviewSummaryComment({
        prSurface: fake.surface,
        reviewLens: "review",
        coordination: { db: state.db, resourceKey: prKey, workItemId: ownerWorkId },
      });
      await ownerSummary.tick({
        body: `${REVIEW_SUMMARY_SENTINEL}\nowner-body`,
        progressRevision: 2,
      });

      const foreignSummary = createReviewSummaryComment({
        prSurface: fake.surface,
        reviewLens: "review",
        coordination: { db: state.db, resourceKey: prKey, workItemId: foreignWorkId },
      });
      const skippedForeign = await foreignSummary.tick({
        body: `${REVIEW_SUMMARY_SENTINEL}\nforeign-body`,
        progressRevision: 3,
      });
      expect(skippedForeign.skipped).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        "review_progress_skipped_foreign_owner",
        expect.objectContaining({ workItemId: foreignWorkId, ownerWorkItemId: ownerWorkId }),
      );

      const skippedGate = await ownerSummary.tick({
        body: `${REVIEW_SUMMARY_SENTINEL}\ngated-body`,
        progressRevision: 4,
        shouldPublish: async () => false,
      });
      expect(skippedGate.skipped).toBe(true);
      expect(fake.controls.getProgressComment(REVIEW_SUMMARY_SENTINEL)?.body).toContain(
        "owner-body",
      );
    } finally {
      state.close();
    }
  });

  it("retries a failed publishOnce summary conclusion only after proven non-acceptance and replays committed results", async () => {
    const state = openSqliteAppState();
    try {
      const now = Date.now();
      const prKey = prResourceKey(OWNER, REPO, 21);
      const workId = randomUUID();
      ensurePrState(state.db, prKey, now);
      insertWorkRun(state.db, { workId, prKey, kind: "review", payloadJson: "{}", now });
      state.db.prepare(`UPDATE work_runs SET status = 'running' WHERE work_id = ?`).run(workId);

      const fake = createFakePrSurface({ owner: OWNER, repo: REPO, prNumber: 21 });
      const summary = createReviewSummaryComment({
        prSurface: fake.surface,
        reviewLens: "review",
        coordination: { db: state.db, resourceKey: prKey, workItemId: workId },
      });
      const operationKey = `review:summary:review:${prKey}`;

      let shouldFail = true;
      const runConclude = () =>
        publishOnce({
          db: state.db,
          workId,
          prKey,
          resourceTarget: "summary_comment:review",
          operationKey,
          mutationKind: "github.summary_comment",
          isKnownNoAcceptanceError: isKnownNoAcceptanceMutationError,
          decodeResult: (value) =>
            v.parse(v.object({ id: v.number(), updated: v.boolean() }), value),
          mutate: async () => {
            if (shouldFail) {
              throw Object.assign(new Error("simulated 403 before acceptance"), {
                status: 403,
              });
            }
            return summary.conclude({ body: `${REVIEW_SUMMARY_SENTINEL}\nwinner` });
          },
        });

      await expect(runConclude()).rejects.toMatchObject({ status: 403 });
      expect(fake.controls.getProgressComment(REVIEW_SUMMARY_SENTINEL)).toBeNull();

      shouldFail = false;
      const first = await runConclude();
      expect(first.id).toBeGreaterThan(0);

      const upsertCallsBefore = fake.controls.events.filter(
        (event) => event.kind === "upsertProgressComment",
      ).length;
      const replayed = await runConclude();
      expect(replayed.id).toBe(first.id);
      expect(
        fake.controls.events.filter((event) => event.kind === "upsertProgressComment"),
      ).toHaveLength(upsertCallsBefore);
      expect(fake.controls.getProgressComment(REVIEW_SUMMARY_SENTINEL)?.body).toContain(
        `workItemId=${workId} value=7`,
      );
    } finally {
      state.close();
    }
  });

  it("enforces FIFO claiming, retry windows, epoch fencing, cancel/supersede, and queue position", () => {
    const state = openSqliteAppState();
    try {
      const now = 1_700_000_000_000;
      const prKey = prResourceKey(OWNER, REPO, 22);
      ensurePrState(state.db, prKey, now);

      insertWorkRun(state.db, {
        workId: "w-1",
        prKey,
        kind: "review",
        laneEpoch: 0,
        payloadJson: "{}",
        now,
      });
      insertWorkRun(state.db, {
        workId: "w-2",
        prKey,
        kind: "review",
        laneEpoch: 0,
        payloadJson: "{}",
        now: now + 10,
      });
      insertWorkRun(state.db, {
        workId: "w-3",
        prKey,
        kind: "ask",
        laneEpoch: 0,
        payloadJson: "{}",
        now: now + 20,
      });

      expect(reviewQueuePosition(state.db, "w-1")).toEqual({ position: 1, total: 2 });
      expect(reviewQueuePosition(state.db, "w-2")).toEqual({ position: 2, total: 2 });
      expect(reviewQueuePosition(state.db, "w-3")).toBeNull();

      const claim1 = claimDispatchableWorkRun(state.db, now + 30, { kinds: ["review"] });
      expect(claim1?.run.work_id).toBe("w-1");
      expect(claim1?.attempt.attempt_no).toBe(1);
      expect(
        markAttemptRunning(state.db, {
          workId: "w-1",
          attemptNo: 1,
          conversationId: "conv-1",
          taskId: "task-1",
          now: now + 31,
        }),
      ).toBe(1);
      expect(reviewQueuePosition(state.db, "w-1")).toBeNull();
      expect(reviewQueuePosition(state.db, "w-2")).toEqual({ position: 1, total: 1 });

      const retryAt = nextRetryAtMs(
        1,
        { retryDelaySeconds: 10, retryDelayMaxSeconds: 60 },
        now + 40,
      );
      expect(retryAt).toBe(now + 40 + 10_000);
      expect(
        scheduleWorkRunRetry(state.db, {
          workId: "w-1",
          attemptNo: 1,
          errorJson: JSON.stringify({ message: "transient" }),
          nextRetryAt: retryAt,
          now: now + 40,
        }),
      ).toBe(1);
      expect(workRunById(state.db, "w-1")?.status).toBe("retry_scheduled");

      const claim2 = claimDispatchableWorkRun(state.db, now + 45, { kinds: ["review"] });
      expect(claim2?.run.work_id).toBe("w-2");
      markAttemptRunning(state.db, {
        workId: "w-2",
        attemptNo: 1,
        conversationId: "conv-2",
        taskId: "task-2",
        now: now + 46,
      });
      expect(cancelWorkRun(state.db, { workId: "w-2", reason: "pr_closed", now: now + 50 })).toBe(
        "conv-2",
      );
      expect(workRunById(state.db, "w-2")?.status).toBe("cancelled");
      expect(attemptFor(state.db, "w-2", 1)?.status).toBe("cancelled");

      expect(
        claimDispatchableWorkRun(state.db, retryAt - 1, { kinds: ["review"] }),
      ).toBeUndefined();
      const retryClaim = claimDispatchableWorkRun(state.db, retryAt, { kinds: ["review"] });
      expect(retryClaim?.run.work_id).toBe("w-1");
      expect(retryClaim?.attempt.attempt_no).toBe(2);
      markAttemptRunning(state.db, {
        workId: "w-1",
        attemptNo: 2,
        conversationId: "conv-1b",
        taskId: "task-1b",
        now: retryAt + 1,
      });

      const pub = createFeaturePublication({
        db: state.db,
        workId: "w-1",
        prKey,
        laneEpoch: 0,
        shutdownRequested: () => false,
        now: () => retryAt + 2,
      });
      expect(pub.current()).toBe(true);
      expect(
        workRunCurrent(state.db, {
          workId: "w-1",
          laneEpoch: 0,
          shutdownRequested: () => false,
        }),
      ).toBe(true);

      bumpLaneEpoch(state.db, { prKey, lane: "review", now: retryAt + 5 });
      expect(pub.current()).toBe(false);
      expect(() => pub.assertCurrent()).toThrow(/no longer current/);
      expect(supersedeWorkRun(state.db, { workId: "w-1", now: retryAt + 6 })).toBe("conv-1b");
      expect(workRunById(state.db, "w-1")?.status).toBe("superseded");

      const askClaim = claimDispatchableWorkRun(state.db, retryAt + 10, { kinds: ["ask"] });
      expect(askClaim?.run.work_id).toBe("w-3");
      markAttemptRunning(state.db, {
        workId: "w-3",
        attemptNo: 1,
        conversationId: "conv-3",
        taskId: "task-3",
        now: retryAt + 11,
      });
      expect(
        markWorkRunFailed(state.db, {
          workId: "w-3",
          attemptNo: 1,
          errorJson: JSON.stringify({ message: "boom" }),
          now: retryAt + 12,
        }),
      ).toBe(1);
      expect(workRunById(state.db, "w-3")?.status).toBe("failed");

      insertWorkRun(state.db, {
        workId: "w-4",
        prKey,
        kind: "ack",
        payloadJson: "{}",
        now: retryAt + 13,
      });
      const ackClaim = claimDispatchableWorkRun(state.db, retryAt + 14, { kinds: ["ack"] });
      expect(ackClaim?.run.work_id).toBe("w-4");
      markAttemptRunning(state.db, {
        workId: "w-4",
        attemptNo: 1,
        conversationId: null,
        taskId: null,
        now: retryAt + 15,
      });
      expect(
        markWorkRunCompleted(state.db, { workId: "w-4", attemptNo: 1, now: retryAt + 16 }),
      ).toBe(1);
      expect(workRunById(state.db, "w-4")?.status).toBe("completed");
    } finally {
      state.close();
    }
  });

  it("tracks publish_records dual keys, inline review lenses, newer-step masking, and approval notices", () => {
    const state = openSqliteAppState();
    try {
      const now = 1_700_000_000_000;
      const prKey = prResourceKey(OWNER, REPO, 23);
      ensurePrState(state.db, prKey, now);
      state.db.prepare(`UPDATE pr_state SET approval_json = ? WHERE pr_key = ?`).run(
        JSON.stringify({
          state: "awaiting",
          headSha: "sha-1",
          workflowStartAdmits: false,
        }),
        prKey,
      );
      expect(approvalNoticePublishable(state.db, prKey, "awaiting")).toBe(true);
      expect(approvalNoticePublishable(state.db, prKey, "withdrawn")).toBe(false);

      recordPublishStep(state.db, {
        workId: "w-a",
        prKey,
        lens: "review",
        step: "progress_comment",
        detail: { progressGeneration: 2 },
        now: now + 1,
      });
      expect(approvalNoticePublishable(state.db, prKey, "awaiting")).toBe(false);
      expect(progressCommentOwner(state.db, prKey, "review")).toEqual({
        workId: "w-a",
        generation: 2,
      });

      recordPublishStep(state.db, {
        workId: "w-a",
        prKey,
        lens: "review",
        step: "inline_review",
        detail: { githubId: 501, reviewLens: "review" },
        now: now + 2,
      });
      expect(inlineReviewLensesForPr(state.db, prKey).get(501)).toBe("review");

      recordPublishStep(state.db, {
        workId: "w-a",
        prKey,
        lens: "review",
        step: "summary_stub",
        detail: { note: "pending" },
        now: now + 3,
      });
      expect(
        latestPublishStepWithoutNewer(state.db, prKey, "review", "summary_stub", "summary_final"),
      ).toEqual({ note: "pending" });

      recordPublishStep(state.db, {
        workId: "w-a",
        prKey,
        lens: "review",
        step: "summary_final",
        detail: { note: "done" },
        now: now + 4,
      });
      expect(
        latestPublishStepWithoutNewer(state.db, prKey, "review", "summary_stub", "summary_final"),
      ).toBeUndefined();
    } finally {
      state.close();
    }
  });
});
