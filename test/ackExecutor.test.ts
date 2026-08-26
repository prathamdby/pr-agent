import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { Config } from "../src/config.js";
import { executeAckJob } from "../src/agentWork/executors/ackExecutor.js";
import type { AckJobData } from "../src/agentWork/types.js";
import {
  GITHUB_REACTION_EYES,
  GITHUB_REACTION_MINUS_ONE,
  GITHUB_REACTION_PLUS_ONE,
  REVIEW_SUMMARY_SENTINEL,
} from "../src/settings/index.js";
import { createFakePrSurface } from "../src/github/prSurface.js";
import * as prSurfaceModule from "../src/github/prSurface.js";

let surfaceBundle = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });

vi.mock("../src/agentWork/durableJob.js", () => ({
  mintInstallationToken: vi.fn(async () => ({
    token: "tok",
    expiresAtTs: Date.now() + 3_600_000,
    ttlMs: 3_600_000,
  })),
}));

vi.mock("../src/review/ci/analyzeCi.js", () => ({
  buildCiSummaryForSurface: vi.fn(async () => null),
}));

vi.mock("../src/agentWork/repository.js", () => ({
  getSummaryCommentGithubId: vi.fn(async () => null),
  getProgressCommentOwner: vi.fn(async () => null),
  getReviewQueuePosition: vi.fn(async () => null),
  getWorkItemCore: vi.fn(async () => ({
    id: "wi-1",
    status: "running",
    type: "review",
  })),
  recordPublishStep: vi.fn(),
  claimSummaryCommentCreation: vi.fn(async () => true),
}));

vi.mock("../src/review/publish/publishReview.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/review/publish/publishReview.js")>();
  return {
    ...actual,
    upsertSummaryCommentWithCreationClaim: vi.fn(async () => ({ id: 42, updated: false })),
  };
});

vi.mock("../src/agentWork/reviewCheckRun.js", () => ({
  ensureReviewCheckRunStarted: vi.fn(),
  cancelReviewCheckRunsForWorkItems: vi.fn(async () => undefined),
}));

vi.mock("../src/evlog.js", () => ({
  logWarn: vi.fn(),
}));

import { upsertSummaryCommentWithCreationClaim } from "../src/review/publish/publishReview.js";
import {
  getProgressCommentOwner,
  getReviewQueuePosition,
  getWorkItemCore,
  recordPublishStep,
} from "../src/agentWork/repository.js";
import {
  cancelReviewCheckRunsForWorkItems,
  ensureReviewCheckRunStarted,
} from "../src/agentWork/reviewCheckRun.js";
import {
  renderReviewProgressComment,
  renderReviewFailureNotice,
} from "../src/review/run/progressComment.js";
import {
  REVIEW_PROGRESS_QUEUE_LABEL,
  REVIEW_PROGRESS_QUEUED_NOTE,
  reviewProgressCancelledNote,
  triageCancelledNotice,
} from "../src/settings/index.js";
import { logWarn } from "../src/evlog.js";

const cfg = {} as Config;
const pool = {} as Pool;

function ackData(): AckJobData {
  return {
    kind: "ack",
    installationId: 42,
    owner: "o",
    repo: "r",
    prNumber: 1,
    targets: [
      { kind: "pr", prNumber: 1 },
      { kind: "issueComment", commentId: 10 },
      { kind: "reviewComment", commentId: 20 },
    ],
  };
}

describe("executeAckJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    surfaceBundle = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
    vi.spyOn(prSurfaceModule, "createPrSurface").mockImplementation(() => surfaceBundle.surface);
  });

  it("posts eyes on every ack target", async () => {
    await expect(executeAckJob(cfg, pool, ackData())).resolves.toBeUndefined();

    expect(surfaceBundle.controls.reactions).toHaveLength(1);
    expect(surfaceBundle.controls.reactions[0]?.targets).toEqual(ackData().targets);
    expect(surfaceBundle.controls.reactions[0]?.kind).toBe(GITHUB_REACTION_EYES);
  });

  it("adds plus-one after ack-only replies with no durable work item", async () => {
    await executeAckJob(cfg, pool, {
      ...ackData(),
      reply: { target: { kind: "prConversation", prNumber: 1 }, body: "help" },
    });

    expect(surfaceBundle.controls.replies).toHaveLength(1);
    expect(surfaceBundle.controls.replies[0]?.body).toBe("help");
    expect(surfaceBundle.controls.reactions).toHaveLength(2);
    expect(surfaceBundle.controls.reactions[1]?.kind).toBe(GITHUB_REACTION_PLUS_ONE);
  });

  it("does not plus-one when a durable work item will own the outcome reaction", async () => {
    await executeAckJob(cfg, pool, {
      ...ackData(),
      workItemId: "wi-1",
      reply: { target: { kind: "prConversation", prNumber: 1 }, body: "hint" },
    });

    expect(surfaceBundle.controls.reactions).toHaveLength(1);
    expect(surfaceBundle.controls.reactions[0]?.kind).toBe(GITHUB_REACTION_EYES);
  });

  it("uses coordinated summary upsert for progress with work item id", async () => {
    await executeAckJob(cfg, pool, {
      ...ackData(),
      workItemId: "wi-1",
      progress: { lens: "review", headSha: "sha", source: "auto" },
    });

    expect(upsertSummaryCommentWithCreationClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        pool,
        workItemId: "wi-1",
        resourceKey: "o/r#1",
        reviewLens: "review",
        progressRevision: 0,
        body: expect.stringMatching(/Review queued/),
        prSurface: surfaceBundle.surface,
      }),
    );
    const queuedBody = vi.mocked(upsertSummaryCommentWithCreationClaim).mock.calls[0]?.[0]?.body;
    expect(queuedBody).not.toMatch(/Recon/);
    expect(queuedBody).not.toMatch(/Correctness/);
    expect(queuedBody).not.toContain(`<strong>${REVIEW_PROGRESS_QUEUE_LABEL}</strong>`);
    const body = vi.mocked(upsertSummaryCommentWithCreationClaim).mock.calls[0]?.[0]?.body;
    expect(body).toContain("<!-- pr-agent:review-meta headSha=invalid lens=review stale=false -->");
    expect(recordPublishStep).not.toHaveBeenCalled();
    expect(ensureReviewCheckRunStarted).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        workItemId: "wi-1",
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "sha",
        reviewLens: "review",
        prSurface: surfaceBundle.surface,
      }),
    );
  });

  it("includes queue position on the queued progress stub when lookup succeeds", async () => {
    vi.mocked(getReviewQueuePosition).mockResolvedValueOnce({ position: 2, total: 10 });

    await executeAckJob(cfg, pool, {
      ...ackData(),
      workItemId: "wi-1",
      progress: { lens: "review", headSha: "sha", source: "auto" },
    });

    expect(getReviewQueuePosition).toHaveBeenCalledWith(pool, "wi-1");
    const body = vi.mocked(upsertSummaryCommentWithCreationClaim).mock.calls[0]?.[0]?.body;
    expect(body).toContain(`<strong>${REVIEW_PROGRESS_QUEUE_LABEL}</strong>`);
    expect(body).toContain("#2 of 10");
  });

  it("omits queue position when lookup fails and still posts the stub", async () => {
    vi.mocked(getReviewQueuePosition).mockRejectedValueOnce(new Error("db down"));

    await executeAckJob(cfg, pool, {
      ...ackData(),
      workItemId: "wi-1",
      progress: { lens: "review", headSha: "sha", source: "auto" },
    });

    expect(upsertSummaryCommentWithCreationClaim).toHaveBeenCalled();
    const body = vi.mocked(upsertSummaryCommentWithCreationClaim).mock.calls[0]?.[0]?.body;
    expect(body).toContain("Review queued");
    expect(body).not.toContain(`<strong>${REVIEW_PROGRESS_QUEUE_LABEL}</strong>`);
  });

  it("uses revision coordination when progress has no work item id", async () => {
    await executeAckJob(cfg, pool, {
      ...ackData(),
      progress: { lens: "review", headSha: "sha", source: "auto" },
    });

    expect(upsertSummaryCommentWithCreationClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        pool,
        workItemId: undefined,
        resourceKey: "o/r#1",
        reviewLens: "review",
        progressRevision: 0,
      }),
    );
    expect(getReviewQueuePosition).not.toHaveBeenCalled();
  });

  it("no-ops progress when the work item is superseded", async () => {
    vi.mocked(getWorkItemCore).mockResolvedValueOnce({
      id: "wi-stale",
      status: "superseded",
      type: "review",
    } as Awaited<ReturnType<typeof getWorkItemCore>>);

    await executeAckJob(cfg, pool, {
      ...ackData(),
      workItemId: "wi-stale",
      progress: { lens: "review", headSha: "sha-a", source: "auto" },
    });

    expect(upsertSummaryCommentWithCreationClaim).not.toHaveBeenCalled();
    expect(ensureReviewCheckRunStarted).not.toHaveBeenCalled();
  });

  it("executes acknowledgements in reverse order without letting A overwrite B", async () => {
    vi.mocked(getWorkItemCore).mockImplementation(async (_pool, id: string) => {
      if (id === "wi-b") {
        return { id: "wi-b", status: "running", type: "review" } as Awaited<
          ReturnType<typeof getWorkItemCore>
        >;
      }
      return { id: "wi-a", status: "superseded", type: "review" } as Awaited<
        ReturnType<typeof getWorkItemCore>
      >;
    });
    // wi-a is superseded, so it never reaches the owner lookup; a second
    // once-value here would leak into later tests.
    vi.mocked(getProgressCommentOwner).mockResolvedValueOnce(null);

    await executeAckJob(cfg, pool, {
      ...ackData(),
      workItemId: "wi-b",
      progress: { lens: "review", headSha: "sha-b", source: "auto" },
    });
    await executeAckJob(cfg, pool, {
      ...ackData(),
      workItemId: "wi-a",
      progress: { lens: "review", headSha: "sha-a", source: "auto" },
    });

    expect(upsertSummaryCommentWithCreationClaim).toHaveBeenCalledTimes(1);
    expect(upsertSummaryCommentWithCreationClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        workItemId: "wi-b",
        progressRevision: 0,
      }),
    );
  });

  it("skips progress when another work item already owns the comment", async () => {
    vi.mocked(getWorkItemCore).mockResolvedValueOnce({
      id: "wi-a",
      status: "running",
      type: "review",
    } as Awaited<ReturnType<typeof getWorkItemCore>>);
    vi.mocked(getProgressCommentOwner).mockResolvedValueOnce({
      workItemId: "wi-b",
      generation: 1,
    });

    await executeAckJob(cfg, pool, {
      ...ackData(),
      workItemId: "wi-a",
      progress: { lens: "review", headSha: "sha-a", source: "auto" },
    });

    expect(upsertSummaryCommentWithCreationClaim).not.toHaveBeenCalled();
  });

  it("replaces an owned progress stub on cancelProgress without upserting", async () => {
    const stub = renderReviewProgressComment({
      mode: "review",
      headSha: "sha",
      source: "slash",
      progressRevision: 1,
      progressWorkItemId: "wi-cancel",
    });
    surfaceBundle.controls.setProgressComment(REVIEW_SUMMARY_SENTINEL, stub, 99);

    await executeAckJob(cfg, pool, {
      ...ackData(),
      cancelProgress: {
        workItemId: "wi-cancel",
        cancelledWorkItemIds: ["wi-cancel"],
        attribution: { kind: "user", login: "alice" },
      },
    });

    const edit = surfaceBundle.controls.events.find((event) => event.kind === "editComment");
    expect(edit).toMatchObject({ kind: "editComment", commentId: 99 });
    const body = edit?.kind === "editComment" ? edit.body : "";
    expect(body).toContain(reviewProgressCancelledNote({ kind: "user", login: "alice" }));
    expect(body).not.toContain("<strong>Recon</strong>");
    expect(upsertSummaryCommentWithCreationClaim).not.toHaveBeenCalled();
    expect(cancelReviewCheckRunsForWorkItems).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        workItemIds: ["wi-cancel"],
        owner: "o",
        repo: "r",
        prNumber: 1,
      }),
    );
  });

  it("publishes a terminal triage cancellation reaction and no-push notice", async () => {
    const data = {
      ...ackData(),
      cancelTriage: {
        workItemId: "triage-cancelled",
        cancelledWorkItemIds: ["triage-cancelled"],
        attribution: { kind: "merged" as const },
        targets: [
          { kind: "pr" as const, prNumber: 1 },
          { kind: "issueComment" as const, commentId: 10 },
        ],
        replyTarget: { kind: "prConversation" as const, prNumber: 1 },
      },
    } satisfies AckJobData;

    await executeAckJob(cfg, pool, data);

    expect(surfaceBundle.controls.reactions).toContainEqual({
      targets: data.cancelTriage.targets,
      kind: GITHUB_REACTION_MINUS_ONE,
    });
    expect(surfaceBundle.controls.replies).toContainEqual({
      target: data.cancelTriage.replyTarget,
      body: triageCancelledNotice(data.cancelTriage.attribution),
    });
  });

  it.each([
    { label: "closed", attribution: { kind: "closed" as const } },
    { label: "user", attribution: { kind: "user" as const, login: "alice" } },
  ])(
    "preserves %s triage cancellation attribution in the terminal notice",
    async ({ attribution }) => {
      const data = {
        ...ackData(),
        cancelTriage: {
          workItemId: "triage-cancelled",
          cancelledWorkItemIds: ["triage-cancelled"],
          attribution,
          targets: [{ kind: "pr" as const, prNumber: 1 }],
          replyTarget: { kind: "prConversation" as const, prNumber: 1 },
        },
      } satisfies AckJobData;

      await executeAckJob(cfg, pool, data);

      expect(surfaceBundle.controls.reactions).toContainEqual({
        targets: data.cancelTriage.targets,
        kind: GITHUB_REACTION_MINUS_ONE,
      });
      expect(surfaceBundle.controls.replies).toContainEqual({
        target: data.cancelTriage.replyTarget,
        body: triageCancelledNotice(attribution),
      });
    },
  );

  it("falls back to upsert when cancelProgress finds a foreign stub", async () => {
    const foreign = renderReviewProgressComment({
      mode: "review",
      headSha: "sha",
      source: "auto",
      progressRevision: 2,
      progressWorkItemId: "wi-other",
    });
    surfaceBundle.controls.setProgressComment(REVIEW_SUMMARY_SENTINEL, foreign, 100);

    await executeAckJob(cfg, pool, {
      ...ackData(),
      cancelProgress: {
        workItemId: "wi-cancel",
        cancelledWorkItemIds: ["wi-cancel"],
        attribution: { kind: "user", login: "alice" },
      },
    });

    expect(surfaceBundle.controls.events.some((event) => event.kind === "editComment")).toBe(false);
    expect(upsertSummaryCommentWithCreationClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        workItemId: "wi-cancel",
        body: expect.stringContaining(
          reviewProgressCancelledNote({ kind: "user", login: "alice" }),
        ),
      }),
    );

    surfaceBundle = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
    vi.spyOn(prSurfaceModule, "createPrSurface").mockImplementation(() => surfaceBundle.surface);
    surfaceBundle.controls.setProgressComment(
      REVIEW_SUMMARY_SENTINEL,
      renderReviewFailureNotice({ mode: "review", retryCommand: "/review" }),
      101,
    );
    vi.mocked(upsertSummaryCommentWithCreationClaim).mockClear();
    vi.mocked(cancelReviewCheckRunsForWorkItems).mockClear();

    await executeAckJob(cfg, pool, {
      ...ackData(),
      cancelProgress: {
        workItemId: "wi-cancel",
        cancelledWorkItemIds: ["wi-cancel", "wi-other"],
        attribution: { kind: "merged" },
      },
    });

    const edit = surfaceBundle.controls.events.find((event) => event.kind === "editComment");
    expect(edit).toMatchObject({ kind: "editComment", commentId: 101 });
    const body = edit?.kind === "editComment" ? edit.body : "";
    expect(body).toContain(reviewProgressCancelledNote({ kind: "merged" }));
    expect(upsertSummaryCommentWithCreationClaim).not.toHaveBeenCalled();
    expect(cancelReviewCheckRunsForWorkItems).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        workItemIds: ["wi-cancel", "wi-other"],
      }),
    );
  });

  it("falls back to the primary work item id when cancelledWorkItemIds is missing", async () => {
    const stub = renderReviewProgressComment({
      mode: "review",
      headSha: "sha",
      source: "auto",
      progressRevision: 1,
      progressWorkItemId: "wi-cancel",
    });
    surfaceBundle.controls.setProgressComment(REVIEW_SUMMARY_SENTINEL, stub, 99);

    await executeAckJob(cfg, pool, {
      ...ackData(),
      cancelProgress: {
        workItemId: "wi-cancel",
        attribution: { kind: "user", login: "alice" },
      },
    });

    expect(cancelReviewCheckRunsForWorkItems).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        workItemIds: ["wi-cancel"],
      }),
    );
  });

  it("passes an empty cancelledWorkItemIds array through without throwing", async () => {
    const stub = renderReviewProgressComment({
      mode: "review",
      headSha: "sha",
      source: "auto",
      progressRevision: 1,
      progressWorkItemId: "wi-cancel",
    });
    surfaceBundle.controls.setProgressComment(REVIEW_SUMMARY_SENTINEL, stub, 99);

    await expect(
      executeAckJob(cfg, pool, {
        ...ackData(),
        cancelProgress: {
          workItemId: "wi-cancel",
          cancelledWorkItemIds: [],
          attribution: { kind: "user", login: "alice" },
        },
      }),
    ).resolves.toBeUndefined();

    expect(cancelReviewCheckRunsForWorkItems).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        workItemIds: [],
      }),
    );
  });

  it("still publishes the cancel comment when check cancellation rejects", async () => {
    const stub = renderReviewProgressComment({
      mode: "review",
      headSha: "sha",
      source: "auto",
      progressRevision: 1,
      progressWorkItemId: "wi-cancel",
    });
    surfaceBundle.controls.setProgressComment(REVIEW_SUMMARY_SENTINEL, stub, 99);
    vi.mocked(cancelReviewCheckRunsForWorkItems).mockRejectedValueOnce(new Error("cancel boom"));

    await expect(
      executeAckJob(cfg, pool, {
        ...ackData(),
        cancelProgress: {
          workItemId: "wi-cancel",
          cancelledWorkItemIds: ["wi-cancel"],
          attribution: { kind: "user", login: "alice" },
        },
      }),
    ).resolves.toBeUndefined();

    const edit = surfaceBundle.controls.events.find((event) => event.kind === "editComment");
    expect(edit).toMatchObject({ kind: "editComment", commentId: 99 });
    expect(logWarn).toHaveBeenCalledWith(
      "ack_cancel_progress_failed",
      expect.objectContaining({
        workItemId: "wi-cancel",
        message: "cancel boom",
      }),
    );
  });

  it("cancels check runs even when the cancel comment edit fails", async () => {
    const stub = renderReviewProgressComment({
      mode: "review",
      headSha: "sha",
      source: "auto",
      progressRevision: 1,
      progressWorkItemId: "wi-cancel",
    });
    surfaceBundle.controls.setProgressComment(REVIEW_SUMMARY_SENTINEL, stub, 99);
    vi.spyOn(surfaceBundle.surface, "editComment").mockRejectedValueOnce(new Error("edit 403"));

    await expect(
      executeAckJob(cfg, pool, {
        ...ackData(),
        cancelProgress: {
          workItemId: "wi-cancel",
          cancelledWorkItemIds: ["wi-cancel"],
          attribution: { kind: "user", login: "alice" },
        },
      }),
    ).resolves.toBeUndefined();

    expect(logWarn).toHaveBeenCalledWith(
      "ack_cancel_comment_failed",
      expect.objectContaining({
        workItemId: "wi-cancel",
        message: "edit 403",
      }),
    );
    expect(cancelReviewCheckRunsForWorkItems).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        workItemIds: ["wi-cancel"],
      }),
    );
  });

  it("runs cancelProgress before progress when a force ack carries both", async () => {
    const stub = renderReviewProgressComment({
      mode: "review",
      headSha: "sha-old",
      source: "slash",
      progressRevision: 1,
      progressWorkItemId: "wi-old",
    });
    surfaceBundle.controls.setProgressComment(REVIEW_SUMMARY_SENTINEL, stub, 99);
    vi.mocked(getWorkItemCore).mockResolvedValueOnce({
      id: "wi-new",
      status: "queued",
      type: "review",
    } as Awaited<ReturnType<typeof getWorkItemCore>>);

    await executeAckJob(cfg, pool, {
      ...ackData(),
      workItemId: "wi-new",
      progress: { lens: "review", headSha: "sha-new", source: "slash" },
      cancelProgress: {
        workItemId: "wi-old",
        cancelledWorkItemIds: ["wi-old"],
        attribution: { kind: "user", login: "alice" },
      },
    });

    // The cancelled notice lands on the old stub first, then the new run's queued stub wins.
    const edit = surfaceBundle.controls.events.find((event) => event.kind === "editComment");
    expect(edit).toMatchObject({ kind: "editComment", commentId: 99 });
    const editBody = edit?.kind === "editComment" ? edit.body : "";
    expect(editBody).toContain(reviewProgressCancelledNote({ kind: "user", login: "alice" }));
    expect(cancelReviewCheckRunsForWorkItems).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ workItemIds: ["wi-old"] }),
    );
    expect(upsertSummaryCommentWithCreationClaim).toHaveBeenCalledTimes(1);
    expect(upsertSummaryCommentWithCreationClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        workItemId: "wi-new",
        body: expect.stringContaining(REVIEW_PROGRESS_QUEUED_NOTE),
      }),
    );
    const cancelOrder = vi.mocked(cancelReviewCheckRunsForWorkItems).mock.invocationCallOrder[0];
    const progressOrder = vi.mocked(upsertSummaryCommentWithCreationClaim).mock
      .invocationCallOrder[0];
    expect(cancelOrder).toBeLessThan(progressOrder);
  });

  it("still publishes the queued stub and reply when the cancel comment edit fails on a force ack", async () => {
    const stub = renderReviewProgressComment({
      mode: "review",
      headSha: "sha-old",
      source: "slash",
      progressRevision: 1,
      progressWorkItemId: "wi-old",
    });
    surfaceBundle.controls.setProgressComment(REVIEW_SUMMARY_SENTINEL, stub, 99);
    vi.spyOn(surfaceBundle.surface, "editComment").mockRejectedValueOnce(new Error("edit 403"));
    // A persistent getWorkItemCore implementation from an earlier test outlives
    // clearAllMocks, so pin this test's row with a consumed once-value.
    vi.mocked(getWorkItemCore).mockResolvedValueOnce({
      id: "wi-new",
      status: "queued",
      type: "review",
    } as Awaited<ReturnType<typeof getWorkItemCore>>);

    await executeAckJob(cfg, pool, {
      ...ackData(),
      workItemId: "wi-new",
      progress: { lens: "review", headSha: "sha-new", source: "slash" },
      cancelProgress: {
        workItemId: "wi-old",
        cancelledWorkItemIds: ["wi-old"],
        attribution: { kind: "user", login: "alice" },
      },
      reply: { target: { kind: "prConversation", prNumber: 1 }, body: "restarted" },
    });

    expect(logWarn).toHaveBeenCalledWith(
      "ack_cancel_comment_failed",
      expect.objectContaining({ workItemId: "wi-old", message: "edit 403" }),
    );
    // Comment I/O failure must not block check cancellation or the new stub.
    expect(cancelReviewCheckRunsForWorkItems).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ workItemIds: ["wi-old"] }),
    );
    expect(upsertSummaryCommentWithCreationClaim).toHaveBeenCalledTimes(1);
    expect(upsertSummaryCommentWithCreationClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        workItemId: "wi-new",
        body: expect.stringContaining(REVIEW_PROGRESS_QUEUED_NOTE),
      }),
    );
    expect(surfaceBundle.controls.replies.map((reply) => reply.body)).toContain("restarted");
  });

  it("still publishes the queued stub and reply when check cancellation rejects on a force ack", async () => {
    const stub = renderReviewProgressComment({
      mode: "review",
      headSha: "sha-old",
      source: "slash",
      progressRevision: 1,
      progressWorkItemId: "wi-old",
    });
    surfaceBundle.controls.setProgressComment(REVIEW_SUMMARY_SENTINEL, stub, 99);
    vi.mocked(cancelReviewCheckRunsForWorkItems).mockRejectedValueOnce(new Error("cancel boom"));
    vi.mocked(getWorkItemCore).mockResolvedValueOnce({
      id: "wi-new",
      status: "queued",
      type: "review",
    } as Awaited<ReturnType<typeof getWorkItemCore>>);

    await executeAckJob(cfg, pool, {
      ...ackData(),
      workItemId: "wi-new",
      progress: { lens: "review", headSha: "sha-new", source: "slash" },
      cancelProgress: {
        workItemId: "wi-old",
        cancelledWorkItemIds: ["wi-old"],
        attribution: { kind: "user", login: "alice" },
      },
      reply: { target: { kind: "prConversation", prNumber: 1 }, body: "restarted" },
    });

    expect(logWarn).toHaveBeenCalledWith(
      "ack_cancel_progress_failed",
      expect.objectContaining({ workItemId: "wi-old", message: "cancel boom" }),
    );
    expect(upsertSummaryCommentWithCreationClaim).toHaveBeenCalledTimes(1);
    expect(upsertSummaryCommentWithCreationClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        workItemId: "wi-new",
        body: expect.stringContaining(REVIEW_PROGRESS_QUEUED_NOTE),
      }),
    );
    expect(surfaceBundle.controls.replies.map((reply) => reply.body)).toContain("restarted");
  });

  it("still publishes the queued stub and reply when the cancel progress lookup throws", async () => {
    vi.spyOn(surfaceBundle.surface, "findProgressComment").mockRejectedValueOnce(
      new Error("lookup boom"),
    );
    vi.mocked(getWorkItemCore).mockResolvedValueOnce({
      id: "wi-new",
      status: "queued",
      type: "review",
    } as Awaited<ReturnType<typeof getWorkItemCore>>);

    await executeAckJob(cfg, pool, {
      ...ackData(),
      workItemId: "wi-new",
      progress: { lens: "review", headSha: "sha-new", source: "slash" },
      cancelProgress: {
        workItemId: "wi-old",
        cancelledWorkItemIds: ["wi-old"],
        attribution: { kind: "user", login: "alice" },
      },
      reply: { target: { kind: "prConversation", prNumber: 1 }, body: "restarted" },
    });

    expect(logWarn).toHaveBeenCalledWith(
      "ack_cancel_progress_failed",
      expect.objectContaining({ workItemId: "wi-old", message: "lookup boom" }),
    );
    // The throw happens before check cancellation; only the new stub and reply land.
    expect(cancelReviewCheckRunsForWorkItems).not.toHaveBeenCalled();
    expect(upsertSummaryCommentWithCreationClaim).toHaveBeenCalledTimes(1);
    expect(upsertSummaryCommentWithCreationClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        workItemId: "wi-new",
        body: expect.stringContaining(REVIEW_PROGRESS_QUEUED_NOTE),
      }),
    );
    expect(surfaceBundle.controls.replies.map((reply) => reply.body)).toContain("restarted");
  });
});
