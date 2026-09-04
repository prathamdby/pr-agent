import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { DurableJobSpec } from "../src/agentWork/durableJob.js";
import type { TriageJobData } from "../src/agentWork/types.js";
import {
  TRIAGE_ALL_PRIOR_FINDINGS_RESOLVED,
  TRIAGE_BULK_PREVIEW_STALE,
  TRIAGE_BULK_REQUIRES_PREVIEW,
  TRIAGE_CLOSED_PR_NOTICE,
  TRIAGE_FAILURE_MESSAGE,
  TRIAGE_PREVIEW_SENTINEL,
  TRIAGE_SUMMARY_SENTINEL,
  TRIAGE_THREAD_NOT_ELIGIBLE,
} from "../src/settings/index.js";
import { makeTestConfig } from "./helpers/config.js";
import {
  durablePrSurfaceControls,
  fakeDurablePrSurface,
  resetDurablePrSurface,
} from "./helpers/executorDurableHarness.js";
import * as prSurfaceModule from "../src/github/prSurface.js";

const mocks = vi.hoisted(() => ({
  runDurableWorkItem: vi.fn(),
  getAppBotIdentity: vi.fn(),
  withWritablePrCheckout: vi.fn(),
  runFullPrTriage: vi.fn(),
  replayPreviewHunks: vi.fn(),
  parseStoredTriagePushDetail: vi.fn(),
  parseStoredTriagePreviewDetail: vi.fn(),
  publishTriage: vi.fn(),
  publishTriagePreview: vi.fn(),
  publishTriageReportOnly: vi.fn(),
  recordPublishStep: vi.fn(),
  getCompletedPublishStepDetail: vi.fn(),
  getCompletedPublishStepDetailWithoutNewerStep: vi.fn(),
  getLatestCompletedPublishStepDetail: vi.fn(),
  hasCompletedPublishStep: vi.fn(),
  listTriageEligibleInlineReviews: vi.fn(),
  shouldSkipWork: vi.fn(),
}));

vi.mock("../src/agentWork/durableJob.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agentWork/durableJob.js")>();
  return { ...actual, runDurableWorkItem: mocks.runDurableWorkItem };
});

vi.mock("../src/github/appAuth.js", () => ({
  getAppBotIdentity: mocks.getAppBotIdentity,
}));

vi.mock("../src/github/reviewThreadResolution.js", () => ({
  warnReviewThreadResolutionDegraded: vi.fn(),
}));

vi.mock("../src/prWorkspace/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/prWorkspace/index.js")>();
  return {
    ...actual,
    withWritablePrCheckout: mocks.withWritablePrCheckout,
  };
});

vi.mock("../src/agent/triage/triageRun.js", () => ({
  runFullPrTriage: mocks.runFullPrTriage,
}));

vi.mock("../src/agent/triage/previewApproval.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agent/triage/previewApproval.js")>();
  return { ...actual, replayPreviewHunks: mocks.replayPreviewHunks };
});

vi.mock("../src/agent/triage/publishTriage.js", () => ({
  parseStoredTriagePushDetail: mocks.parseStoredTriagePushDetail,
  parseStoredTriagePreviewDetail: mocks.parseStoredTriagePreviewDetail,
  publishTriage: mocks.publishTriage,
  publishTriagePreview: mocks.publishTriagePreview,
  publishTriageReportOnly: mocks.publishTriageReportOnly,
}));

vi.mock("../src/agentWork/repository.js", () => ({
  getCompletedPublishStepDetail: mocks.getCompletedPublishStepDetail,
  getCompletedPublishStepDetailWithoutNewerStep:
    mocks.getCompletedPublishStepDetailWithoutNewerStep,
  getLatestCompletedPublishStepDetail: mocks.getLatestCompletedPublishStepDetail,
  hasCompletedPublishStep: mocks.hasCompletedPublishStep,
  listTriageEligibleInlineReviews: mocks.listTriageEligibleInlineReviews,
  recordPublishStep: mocks.recordPublishStep,
  shouldSkipWork: mocks.shouldSkipWork,
}));

vi.mock("../src/agentWork/prActorLease.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agentWork/prActorLease.js")>();
  return { ...actual, assertPrActorLeaseHeld: vi.fn().mockResolvedValue(undefined) };
});

import { executeTriageJob } from "../src/agentWork/executors/triageExecutor.js";
import { makeTriageWorkItem } from "./helpers/agentWorkItems.js";

const cfg = makeTestConfig();
const pool = {} as Pool;
const boss = {} as PgBoss;

function item(overrides: Parameters<typeof makeTriageWorkItem>[0] = {}) {
  return makeTriageWorkItem({ headSha: "head", ...overrides });
}

function job(): JobWithMetadata<TriageJobData> {
  return {
    data: { kind: "triage", workItemId: "wi-1" },
  } as JobWithMetadata<TriageJobData>;
}

function mockDurableExecution(workItem = item()): void {
  mocks.runDurableWorkItem.mockImplementation(async (spec: DurableJobSpec<"triage">) =>
    spec.execute(workItem, {
      prSurface: fakeDurablePrSurface(),
      headSha: "a".repeat(40),
      leaseEpoch: 1,
      signal: new AbortController().signal,
    }),
  );
}

function storedPreview(
  overrides: {
    readonly headSha?: string;
    readonly threadRootCommentIds?: readonly number[];
    readonly hunks?: readonly {
      readonly threadRootCommentId: number;
      readonly subject: string;
      readonly diff: string;
    }[];
  } = {},
) {
  const threadRootCommentIds = overrides.threadRootCommentIds ?? [1];
  return {
    headSha: overrides.headSha ?? "a".repeat(40),
    threadRootCommentIds,
    hunks:
      overrides.hunks ??
      threadRootCommentIds.map((threadRootCommentId) => ({
        threadRootCommentId,
        subject: "fix: app",
        diff: "diff --git a/src/app.ts b/src/app.ts\n+ok\n",
      })),
    payload: {
      verdicts: threadRootCommentIds.map((threadRootCommentId) => ({
        verdict: "fixed" as const,
        threadRootCommentId,
        commitSha: "c".repeat(40),
        evidence: "fixed",
      })),
    },
  };
}

function configureDefaultThreads(
  entries: ReadonlyArray<readonly [number, { threadNodeId: string; isResolved: boolean }]>,
) {
  durablePrSurfaceControls().setThreads(new Map(entries));
}

describe("executeTriageJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDurablePrSurface();
    vi.spyOn(prSurfaceModule, "createPrSurface").mockImplementation(() => fakeDurablePrSurface());
    mockDurableExecution();
    configureDefaultThreads([[1, { threadNodeId: "node", isResolved: false }]]);
    mocks.getAppBotIdentity.mockResolvedValue({ userId: 999, login: "pr-agent[bot]" });
    durablePrSurfaceControls().setBotFindingThreads([
      {
        rootCommentId: 1,
        lens: "review",
        path: "src/app.ts",
        line: 1,
        severity: "P1",
        titleSnippet: "P1 · Bug",
        humanReplies: [],
        threadUrl: "https://github.test/thread",
      },
    ]);
    mocks.withWritablePrCheckout.mockImplementation(async (_params, run) =>
      run({
        dir: "/tmp/checkout",
        headRef: "branch",
        baseSha: "a".repeat(40),
        commit: vi.fn(),
        push: vi.fn(),
        listCommittedShas: () => [],
        listCommittedDetails: () => [],
      }),
    );
    mocks.replayPreviewHunks.mockResolvedValue({
      commitByThreadRootCommentId: new Map([[1, "d".repeat(40)]]),
      commitErrors: [],
    });
    mocks.runFullPrTriage.mockResolvedValue({
      submitted: true,
      payload: { verdicts: [{ verdict: "skipped", threadRootCommentId: 1, reason: "later" }] },
      commitByThreadRootCommentId: new Map(),
      commitErrors: [],
    });
    mocks.parseStoredTriagePushDetail.mockImplementation((detail) => ({
      payload: detail.payload,
      commits: detail.commits,
      pushOutcome:
        detail.pushOutcome ??
        (detail.staleHead === true
          ? "stale"
          : detail.commits?.length > 0
            ? "pushed"
            : "not-needed"),
      pushedHeadSha: detail.pushedHeadSha,
    }));
    mocks.publishTriage.mockResolvedValue({
      pushOutcome: "pushed",
      missingThreadAction: false,
    });
    mocks.publishTriageReportOnly.mockResolvedValue(undefined);
    mocks.publishTriagePreview.mockImplementation(
      async (params: {
        prSurface: { upsertProgressComment: (body: string, sentinel: string) => Promise<unknown> };
        inventory: { rootCommentId: number }[];
        hunks: unknown[];
        headSha: string;
      }) => {
        await params.prSurface.upsertProgressComment(
          TRIAGE_PREVIEW_SENTINEL,
          TRIAGE_PREVIEW_SENTINEL,
        );
        await mocks.recordPublishStep(pool, {
          step: "triage_preview",
          detail: {
            headSha: params.headSha,
            threadRootCommentIds: params.inventory.map((thread) => thread.rootCommentId),
            hunks: params.hunks,
            payload: "payload" in params ? params.payload : undefined,
          },
        });
      },
    );
    mocks.parseStoredTriagePreviewDetail.mockImplementation((detail) => detail);
    mocks.recordPublishStep.mockResolvedValue(undefined);
    mocks.getCompletedPublishStepDetail.mockResolvedValue(null);
    mocks.getCompletedPublishStepDetailWithoutNewerStep.mockResolvedValue(null);
    mocks.getLatestCompletedPublishStepDetail.mockResolvedValue(null);
    mocks.hasCompletedPublishStep.mockResolvedValue(false);
    mocks.listTriageEligibleInlineReviews.mockResolvedValue(new Map());
    mocks.shouldSkipWork.mockResolvedValue(false);
    durablePrSurfaceControls().setReviewCommentParentGraph([]);
    durablePrSurfaceControls().setGithubUser(42, {
      id: 42,
      login: "alice",
      name: "Alice",
      email: null,
      type: "User",
    });
  });

  it("runs triage and publishes", async () => {
    await executeTriageJob(cfg, pool, boss, job());

    expect(mocks.withWritablePrCheckout).toHaveBeenCalled();
    expect(mocks.runFullPrTriage).toHaveBeenCalled();
    expect(mocks.publishTriage).toHaveBeenCalled();
  });

  it("handles closure after commit and before push as degraded no-push triage", async () => {
    const { publishTriage: realPublishTriage } = await vi.importActual<
      typeof import("../src/agent/triage/publishTriage.js")
    >("../src/agent/triage/publishTriage.js");
    mocks.publishTriage.mockImplementation(realPublishTriage);
    const committedSha = "c".repeat(40);
    const committed = [{ sha: committedSha, subject: "fix: app", diff: "+ok\n" }];
    const gitPush = vi.fn(async () => undefined);
    const payload = {
      verdicts: [
        {
          verdict: "fixed" as const,
          threadRootCommentId: 1,
          commitSha: committedSha,
          evidence: "fixed",
        },
      ],
    };
    let executeResult: unknown;
    mocks.runDurableWorkItem.mockImplementation(async (spec: DurableJobSpec<"triage">) => {
      executeResult = await spec.execute(item(), {
        prSurface: fakeDurablePrSurface(),
        headSha: "a".repeat(40),
        leaseEpoch: 1,
        signal: new AbortController().signal,
      });
    });
    mocks.withWritablePrCheckout.mockImplementation(async (params, run) => {
      const checkout = {
        dir: "/tmp/checkout",
        headRef: "branch",
        baseSha: "a".repeat(40),
        commit: vi.fn(async () => {
          await params.beforeCommit?.();
          durablePrSurfaceControls().setPullRequest({
            additions: 1,
            deletions: 0,
            changed_files: 1,
            state: "closed",
            merged: false,
            merged_at: null,
            head: { sha: "a".repeat(40) },
          });
          return { sha: committedSha, diff: "+ok\n" };
        }),
        push: vi.fn(async () => {
          await params.beforePush?.();
          await gitPush();
        }),
        listCommittedShas: () => committed.map((entry) => entry.sha),
        listCommittedDetails: () => [...committed],
      };
      return run(checkout);
    });
    mocks.runFullPrTriage.mockImplementation(async ({ checkout }) => {
      await checkout.commit({ files: ["src/app.ts"], subject: "fix: app" });
      return {
        submitted: true,
        payload,
      };
    });
    const publishPool = {
      query: vi.fn(async () => ({ rows: [] })),
    } as unknown as Pool;

    await executeTriageJob(cfg, publishPool, boss, job());

    expect(executeResult).toEqual({ kind: "completed", degraded: true });
    expect(gitPush).not.toHaveBeenCalled();
    const progress = durablePrSurfaceControls().getProgressComment(TRIAGE_SUMMARY_SENTINEL);
    expect(progress?.body).toContain("Triage was cancelled because the pull request is closed");
    expect(mocks.recordPublishStep).toHaveBeenCalledWith(
      publishPool,
      expect.objectContaining({
        step: "triage_push",
        detail: expect.objectContaining({
          pushOutcome: "closed",
          attemptedShas: [committedSha],
        }),
      }),
    );
  });

  it("handles closure that lands while the push is in flight as degraded no-push triage", async () => {
    const { publishTriage: realPublishTriage } = await vi.importActual<
      typeof import("../src/agent/triage/publishTriage.js")
    >("../src/agent/triage/publishTriage.js");
    mocks.publishTriage.mockImplementation(realPublishTriage);
    const committedSha = "c".repeat(40);
    const committed = [{ sha: committedSha, subject: "fix: app", diff: "+ok\n" }];
    const gitPush = vi.fn(async () => {
      durablePrSurfaceControls().setPullRequest({
        additions: 1,
        deletions: 0,
        changed_files: 1,
        state: "closed",
        merged: true,
        merged_at: "2026-01-01T00:00:00Z",
        head: { sha: "a".repeat(40) },
      });
    });
    const payload = {
      verdicts: [
        {
          verdict: "fixed" as const,
          threadRootCommentId: 1,
          commitSha: committedSha,
          evidence: "fixed",
        },
      ],
    };
    let executeResult: unknown;
    mocks.runDurableWorkItem.mockImplementation(async (spec: DurableJobSpec<"triage">) => {
      executeResult = await spec.execute(item(), {
        prSurface: fakeDurablePrSurface(),
        headSha: "a".repeat(40),
        leaseEpoch: 1,
        signal: new AbortController().signal,
      });
    });
    mocks.withWritablePrCheckout.mockImplementation(async (params, run) => {
      const checkout = {
        dir: "/tmp/checkout",
        headRef: "branch",
        baseSha: "a".repeat(40),
        commit: vi.fn(async () => {
          await params.beforeCommit?.();
          return { sha: committedSha, diff: "+ok\n" };
        }),
        push: vi.fn(async () => {
          await params.beforePush?.();
          await gitPush();
        }),
        listCommittedShas: () => committed.map((entry) => entry.sha),
        listCommittedDetails: () => [...committed],
      };
      return run(checkout);
    });
    mocks.runFullPrTriage.mockImplementation(async ({ checkout }) => {
      await checkout.commit({ files: ["src/app.ts"], subject: "fix: app" });
      return {
        submitted: true,
        payload,
      };
    });
    const publishPool = {
      query: vi.fn(async () => ({ rows: [] })),
    } as unknown as Pool;

    await executeTriageJob(cfg, publishPool, boss, job());

    expect(executeResult).toEqual({ kind: "completed", degraded: true });
    expect(gitPush).toHaveBeenCalledTimes(1);
    expect(durablePrSurfaceControls().replies).toHaveLength(0);
    expect(
      durablePrSurfaceControls().events.some((event) => event.kind === "resolveInlineReviewThread"),
    ).toBe(false);
    const progress = durablePrSurfaceControls().getProgressComment(TRIAGE_SUMMARY_SENTINEL);
    expect(progress?.body).toContain(TRIAGE_CLOSED_PR_NOTICE);
    expect(progress?.body).not.toContain("Pushed commits:");
    const pushRecords = mocks.recordPublishStep.mock.calls.flatMap(([, params]) =>
      params.step === "triage_push" ? [params.detail] : [],
    );
    expect(pushRecords).toEqual([
      expect.objectContaining({ pushOutcome: "closed", attemptedShas: [committedSha] }),
    ]);
    expect(pushRecords[0]).not.toHaveProperty("pushedShas");
  });

  it("stops before fetching branch information when cancellation is observed", async () => {
    mocks.shouldSkipWork.mockResolvedValue(true);

    await expect(executeTriageJob(cfg, pool, boss, job())).rejects.toMatchObject({
      code: "triage.cancelled",
    });

    expect(
      durablePrSurfaceControls().events.some((event) => event.kind === "getPullRequestBranchInfo"),
    ).toBe(false);
    expect(mocks.withWritablePrCheckout).not.toHaveBeenCalled();
    expect(mocks.publishTriageReportOnly).not.toHaveBeenCalled();
  });

  it("stops before publishing an empty-inventory report when cancellation arrives", async () => {
    durablePrSurfaceControls().setBotFindingThreads([]);
    configureDefaultThreads([]);
    mocks.shouldSkipWork
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await expect(executeTriageJob(cfg, pool, boss, job())).rejects.toMatchObject({
      code: "triage.cancelled",
    });

    expect(mocks.publishTriageReportOnly).not.toHaveBeenCalled();
    expect(mocks.withWritablePrCheckout).not.toHaveBeenCalled();
  });

  it("stops before resuming a stored push when cancellation arrives", async () => {
    mocks.shouldSkipWork
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await expect(executeTriageJob(cfg, pool, boss, job())).rejects.toMatchObject({
      code: "triage.cancelled",
    });

    expect(mocks.getCompletedPublishStepDetail).not.toHaveBeenCalled();
    expect(mocks.getCompletedPublishStepDetailWithoutNewerStep).not.toHaveBeenCalled();
    expect(mocks.withWritablePrCheckout).not.toHaveBeenCalled();
    expect(mocks.publishTriage).not.toHaveBeenCalled();
  });

  it("passes durable cancellation and final PR-state guards through the seams", async () => {
    await executeTriageJob(cfg, pool, boss, job());

    const checkoutParams = mocks.withWritablePrCheckout.mock.calls[0]?.[0] as {
      beforeCommit: () => Promise<void>;
      beforePush: () => Promise<void>;
    };
    const triageParams = mocks.runFullPrTriage.mock.calls[0]?.[0] as {
      refreshBeforeTool: (toolName: string) => Promise<void>;
    };

    await expect(checkoutParams.beforeCommit()).resolves.toBeUndefined();
    await expect(checkoutParams.beforePush()).resolves.toBeUndefined();

    durablePrSurfaceControls().setPullRequest({
      additions: 0,
      deletions: 0,
      changed_files: 0,
      state: "closed",
      merged: false,
      merged_at: null,
      head: { sha: "a".repeat(40) },
    });
    await expect(checkoutParams.beforeCommit()).rejects.toMatchObject({
      code: "triage.closed_pull_request",
    });
    await expect(checkoutParams.beforePush()).rejects.toMatchObject({
      code: "triage.closed_pull_request",
    });

    mocks.shouldSkipWork.mockResolvedValue(true);
    await expect(triageParams.refreshBeforeTool("commitFix")).rejects.toMatchObject({
      code: "triage.cancelled",
    });
  });

  it.each([
    ["closed", false, null],
    ["merged", true, "2026-01-01T00:00:00Z"],
  ] as const)("blocks both write guards for a %s PR", async (_label, merged, mergedAt) => {
    await executeTriageJob(cfg, pool, boss, job());
    const checkoutParams = mocks.withWritablePrCheckout.mock.calls[0]?.[0] as {
      beforeCommit: () => Promise<void>;
      beforePush: () => Promise<void>;
    };
    durablePrSurfaceControls().setPullRequest({
      additions: 0,
      deletions: 0,
      changed_files: 0,
      state: "closed",
      merged,
      merged_at: mergedAt,
      head: { sha: "a".repeat(40) },
    });

    await expect(checkoutParams.beforeCommit()).rejects.toMatchObject({
      code: "triage.closed_pull_request",
    });
    await expect(checkoutParams.beforePush()).rejects.toMatchObject({
      code: "triage.closed_pull_request",
    });
  });

  it("passes human commit attribution when commenter resolves", async () => {
    mockDurableExecution(
      item({
        payload: {
          source: "slash",
          commentId: 5,
          scope: "all",
          replyTarget: { kind: "prConversation", prNumber: 1 },
          commenterId: 42,
        },
      }),
    );

    await executeTriageJob(cfg, pool, boss, job());

    expect(
      durablePrSurfaceControls().events.some(
        (event) => event.kind === "lookupGitHubUser" && event.userId === 42,
      ),
    ).toBe(true);
    expect(mocks.withWritablePrCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        commitAttribution: expect.objectContaining({
          source: "human",
          person: {
            name: "Alice",
            email: "42+alice@users.noreply.github.com",
          },
          coAuthoredBy: [
            {
              name: "pr-agent[bot]",
              email: "999+pr-agent[bot]@users.noreply.github.com",
            },
          ],
        }),
      }),
      expect.any(Function),
    );
  });

  it("falls back to App attribution when commenter is the bot", async () => {
    mockDurableExecution(
      item({
        payload: {
          source: "slash",
          commentId: 5,
          scope: "all",
          replyTarget: { kind: "prConversation", prNumber: 1 },
          commenterId: 999,
        },
      }),
    );

    await executeTriageJob(cfg, pool, boss, job());

    expect(
      durablePrSurfaceControls().events.some((event) => event.kind === "lookupGitHubUser"),
    ).toBe(false);
    expect(mocks.withWritablePrCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        commitAttribution: expect.objectContaining({
          source: "app",
          coAuthoredBy: [],
        }),
      }),
      expect.any(Function),
    );
  });

  it("falls back to App attribution when user lookup fails", async () => {
    mockDurableExecution(
      item({
        payload: {
          source: "slash",
          commentId: 5,
          scope: "all",
          replyTarget: { kind: "prConversation", prNumber: 1 },
          commenterId: 42,
        },
      }),
    );
    durablePrSurfaceControls().setGithubUser(42, null);

    await executeTriageJob(cfg, pool, boss, job());

    expect(mocks.withWritablePrCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        commitAttribution: expect.objectContaining({
          source: "app",
          coAuthoredBy: [],
        }),
      }),
      expect.any(Function),
    );
  });

  it("fork PRs publish report only and never create checkout", async () => {
    durablePrSurfaceControls().setPullRequestBranchInfo({ headRef: "branch", sameRepo: false });

    await executeTriageJob(cfg, pool, boss, job());

    expect(mocks.publishTriageReportOnly).toHaveBeenCalled();
    expect(mocks.withWritablePrCheckout).not.toHaveBeenCalled();
  });

  it("reports already-resolved threads without implying no review ran", async () => {
    configureDefaultThreads([[1, { threadNodeId: "node", isResolved: true }]]);

    await executeTriageJob(cfg, pool, boss, job());

    expect(mocks.publishTriageReportOnly).toHaveBeenCalledWith(
      expect.objectContaining({
        inventory: [],
        previouslyResolvedCount: 1,
        body: expect.stringContaining(TRIAGE_ALL_PRIOR_FINDINGS_RESOLVED),
      }),
    );
    expect(mocks.publishTriageReportOnly.mock.calls[0]?.[0].body).toContain("Inventory items: 1");
    expect(mocks.publishTriageReportOnly.mock.calls[0]?.[0].body).toContain(
      "Previously resolved: 1",
    );
    expect(mocks.withWritablePrCheckout).not.toHaveBeenCalled();
  });

  it("resumes publish from stored push detail without rerunning agent", async () => {
    const payload = {
      verdicts: [{ verdict: "skipped" as const, threadRootCommentId: 1, reason: "later" }],
    };
    mocks.getCompletedPublishStepDetail.mockResolvedValue({
      pushedShas: ["abc1234"],
      commits: [{ sha: "abc1234", subject: "fix: guard user", diff: "+ok\n" }],
      pushedHeadSha: "a".repeat(40),
      payload,
    });

    await executeTriageJob(cfg, pool, boss, job());

    expect(mocks.withWritablePrCheckout).not.toHaveBeenCalled();
    expect(mocks.runFullPrTriage).not.toHaveBeenCalled();
    expect(mocks.publishTriage).toHaveBeenCalledWith(
      expect.objectContaining({
        payload,
        priorPush: expect.objectContaining({ pushOutcome: "pushed" }),
      }),
    );
  });

  it("runs a fresh agent pass when same-work-item push detail is stale", async () => {
    mocks.getCompletedPublishStepDetail.mockResolvedValue({
      staleHead: true,
      attemptedShas: ["abc1234"],
      commits: [{ sha: "abc1234", subject: "fix: guard user", diff: "+ok\n" }],
      payload: {
        verdicts: [{ verdict: "skipped" as const, threadRootCommentId: 1, reason: "later" }],
      },
    });

    await executeTriageJob(cfg, pool, boss, job());

    expect(mocks.withWritablePrCheckout).toHaveBeenCalled();
    expect(mocks.runFullPrTriage).toHaveBeenCalled();
  });

  it("does not resume a terminal closed push detail", async () => {
    mocks.getCompletedPublishStepDetail.mockResolvedValue({
      pushOutcome: "closed",
      attemptedShas: ["abc1234"],
      commits: [{ sha: "abc1234", subject: "fix: guard user", diff: "+ok\n" }],
      pushedHeadSha: "a".repeat(40),
      payload: {
        verdicts: [{ verdict: "skipped" as const, threadRootCommentId: 1, reason: "later" }],
      },
    });

    await executeTriageJob(cfg, pool, boss, job());

    expect(mocks.withWritablePrCheckout).toHaveBeenCalled();
    expect(mocks.runFullPrTriage).toHaveBeenCalled();
  });

  it("runs a fresh agent pass when same-work-item push detail has stale head", async () => {
    mocks.getCompletedPublishStepDetail.mockResolvedValue({
      pushedShas: ["abc1234"],
      commits: [{ sha: "abc1234", subject: "fix: guard user", diff: "+ok\n" }],
      pushedHeadSha: "b".repeat(40),
      payload: {
        verdicts: [{ verdict: "skipped" as const, threadRootCommentId: 1, reason: "later" }],
      },
    });

    await executeTriageJob(cfg, pool, boss, job());

    expect(mocks.withWritablePrCheckout).toHaveBeenCalled();
    expect(mocks.runFullPrTriage).toHaveBeenCalled();
  });

  it("resumes latest unreported push from a prior triage work item", async () => {
    const payload = {
      verdicts: [{ verdict: "skipped" as const, threadRootCommentId: 1, reason: "later" }],
    };
    mocks.getCompletedPublishStepDetailWithoutNewerStep.mockResolvedValue({
      pushedShas: ["abc1234"],
      commits: [{ sha: "abc1234", subject: "fix: guard user", diff: "+ok\n" }],
      pushedHeadSha: "a".repeat(40),
      payload,
    });

    await executeTriageJob(cfg, pool, boss, job());

    expect(mocks.withWritablePrCheckout).not.toHaveBeenCalled();
    expect(mocks.runFullPrTriage).not.toHaveBeenCalled();
    expect(mocks.publishTriage).toHaveBeenCalledWith(
      expect.objectContaining({
        payload,
        priorPush: expect.objectContaining({ pushOutcome: "pushed" }),
      }),
    );
  });

  it("runs a fresh agent pass when cross-work-item push detail misses current inventory", async () => {
    durablePrSurfaceControls().setBotFindingThreads([
      {
        rootCommentId: 1,
        lens: "review",
        path: "src/app.ts",
        line: 1,
        severity: "P1",
        titleSnippet: "P1 · Bug",
        humanReplies: [],
        threadUrl: "https://github.test/thread-1",
      },
      {
        rootCommentId: 2,
        lens: "review",
        path: "src/other.ts",
        line: 2,
        severity: "P2",
        titleSnippet: "P2 · Other",
        humanReplies: [],
        threadUrl: "https://github.test/thread-2",
      },
    ]);
    configureDefaultThreads([
      [1, { threadNodeId: "node-1", isResolved: false }],
      [2, { threadNodeId: "node-2", isResolved: false }],
    ]);
    mocks.getCompletedPublishStepDetailWithoutNewerStep.mockResolvedValue({
      pushedShas: ["abc1234"],
      commits: [{ sha: "abc1234", subject: "fix: guard user", diff: "+ok\n" }],
      pushedHeadSha: "a".repeat(40),
      payload: {
        verdicts: [{ verdict: "skipped" as const, threadRootCommentId: 1, reason: "later" }],
      },
    });

    await executeTriageJob(cfg, pool, boss, job());

    expect(mocks.withWritablePrCheckout).toHaveBeenCalled();
    expect(mocks.runFullPrTriage).toHaveBeenCalled();
  });

  it("runs a fresh agent pass when cross-work-item push detail has extra verdicts", async () => {
    mocks.getCompletedPublishStepDetailWithoutNewerStep.mockResolvedValue({
      pushedShas: ["abc1234"],
      commits: [{ sha: "abc1234", subject: "fix: guard user", diff: "+ok\n" }],
      pushedHeadSha: "a".repeat(40),
      payload: {
        verdicts: [
          { verdict: "skipped" as const, threadRootCommentId: 1, reason: "later" },
          { verdict: "skipped" as const, threadRootCommentId: 2, reason: "already handled" },
        ],
      },
    });

    await executeTriageJob(cfg, pool, boss, job());

    expect(mocks.withWritablePrCheckout).toHaveBeenCalled();
    expect(mocks.runFullPrTriage).toHaveBeenCalled();
  });

  it("filters inventory to one thread when scope is thread", async () => {
    durablePrSurfaceControls().setBotFindingThreads([
      {
        rootCommentId: 1,
        lens: "review",
        path: "src/a.ts",
        line: 1,
        severity: "P1",
        titleSnippet: "P1 · A",
        humanReplies: [],
        threadUrl: "https://github.test/1",
      },
      {
        rootCommentId: 2,
        lens: "review-quality",
        path: "src/b.ts",
        line: 2,
        severity: "P2",
        titleSnippet: "P2 · B",
        humanReplies: [],
        threadUrl: "https://github.test/2",
      },
    ]);
    configureDefaultThreads([
      [1, { threadNodeId: "node-1", isResolved: false }],
      [2, { threadNodeId: "node-2", isResolved: false }],
    ]);
    durablePrSurfaceControls().setReviewCommentParentGraph([
      { id: 1, inReplyToId: null },
      { id: 9, inReplyToId: 1 },
    ]);
    mockDurableExecution(
      item({
        payload: {
          source: "slash",
          commentId: 9,
          scope: "thread",
          threadAnchorCommentId: 9,
          needsThreadRootResolution: true,
          replyTarget: {
            kind: "inlineReviewThread",
            prNumber: 1,
            inReplyToCommentId: 1,
          },
        },
      }),
    );

    await executeTriageJob(cfg, pool, boss, job());

    expect(mocks.runFullPrTriage).toHaveBeenCalledWith(
      expect.objectContaining({
        inventory: [expect.objectContaining({ rootCommentId: 1 })],
        scope: "thread",
      }),
    );
    expect(
      durablePrSurfaceControls().events.some((e) => e.kind === "fetchReviewCommentParentGraph"),
    ).toBe(true);
  });

  it("falls back to the original inline parent when thread-root resolution fails", async () => {
    durablePrSurfaceControls().setBotFindingThreads([
      {
        rootCommentId: 9,
        lens: "review",
        path: "src/a.ts",
        line: 1,
        severity: "P1",
        titleSnippet: "P1 · A",
        humanReplies: [],
        threadUrl: "https://github.test/9",
      },
    ]);
    configureDefaultThreads([[9, { threadNodeId: "node-9", isResolved: false }]]);
    vi.spyOn(durablePrSurfaceControls(), "setReviewCommentParentGraph");
    mockDurableExecution(
      item({
        payload: {
          source: "slash",
          commentId: 9,
          scope: "thread",
          threadAnchorCommentId: 9,
          needsThreadRootResolution: true,
          replyTarget: {
            kind: "inlineReviewThread",
            prNumber: 1,
            inReplyToCommentId: 9,
          },
        },
      }),
    );

    await executeTriageJob(cfg, pool, boss, job());

    expect(mocks.runFullPrTriage).toHaveBeenCalledWith(
      expect.objectContaining({
        inventory: [expect.objectContaining({ rootCommentId: 9 })],
        scope: "thread",
      }),
    );
  });

  it("reports ineligible thread scope without running the agent", async () => {
    durablePrSurfaceControls().setBotFindingThreads([
      {
        rootCommentId: 1,
        lens: "review",
        path: "src/a.ts",
        line: 1,
        severity: "P1",
        titleSnippet: "P1 · A",
        humanReplies: [],
        threadUrl: "https://github.test/1",
      },
    ]);
    durablePrSurfaceControls().setReviewCommentParentGraph([{ id: 99, inReplyToId: null }]);
    mockDurableExecution(
      item({
        payload: {
          source: "slash",
          commentId: 99,
          scope: "thread",
          threadAnchorCommentId: 99,
          replyTarget: {
            kind: "inlineReviewThread",
            prNumber: 1,
            inReplyToCommentId: 99,
          },
        },
      }),
    );

    await executeTriageJob(cfg, pool, boss, job());

    expect(mocks.publishTriageReportOnly).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining(TRIAGE_THREAD_NOT_ELIGIBLE),
      }),
    );
    expect(mocks.withWritablePrCheckout).not.toHaveBeenCalled();
  });

  it("reports already-resolved scoped thread without calling it ineligible", async () => {
    durablePrSurfaceControls().setBotFindingThreads([
      {
        rootCommentId: 1,
        lens: "review",
        path: "src/a.ts",
        line: 1,
        severity: "P1",
        titleSnippet: "P1 · A",
        humanReplies: [],
        threadUrl: "https://github.test/1",
      },
    ]);
    configureDefaultThreads([[1, { threadNodeId: "node-1", isResolved: true }]]);
    durablePrSurfaceControls().setReviewCommentParentGraph([
      { id: 1, inReplyToId: null },
      { id: 9, inReplyToId: 1 },
    ]);
    mockDurableExecution(
      item({
        payload: {
          source: "slash",
          commentId: 9,
          scope: "thread",
          threadAnchorCommentId: 9,
          needsThreadRootResolution: true,
          replyTarget: {
            kind: "inlineReviewThread",
            prNumber: 1,
            inReplyToCommentId: 1,
          },
        },
      }),
    );

    await executeTriageJob(cfg, pool, boss, job());

    expect(mocks.publishTriageReportOnly).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining(TRIAGE_ALL_PRIOR_FINDINGS_RESOLVED),
      }),
    );
    expect(mocks.publishTriageReportOnly.mock.calls[0]?.[0].body).not.toContain(
      TRIAGE_THREAD_NOT_ELIGIBLE,
    );
    expect(mocks.withWritablePrCheckout).not.toHaveBeenCalled();
  });

  it("does not fall back to full PR triage when thread scope lacks an anchor", async () => {
    durablePrSurfaceControls().setBotFindingThreads([
      {
        rootCommentId: 1,
        lens: "review",
        path: "src/a.ts",
        line: 1,
        severity: "P1",
        titleSnippet: "P1 · A",
        humanReplies: [],
        threadUrl: "https://github.test/1",
      },
    ]);
    mockDurableExecution(
      item({
        payload: {
          source: "slash",
          commentId: 9,
          scope: "thread",
          replyTarget: {
            kind: "inlineReviewThread",
            prNumber: 1,
            inReplyToCommentId: 1,
          },
        },
      }),
    );

    await executeTriageJob(cfg, pool, boss, job());

    expect(
      durablePrSurfaceControls().events.some((e) => e.kind === "fetchReviewCommentParentGraph"),
    ).toBe(false);
    expect(mocks.publishTriageReportOnly).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining(TRIAGE_THREAD_NOT_ELIGIBLE),
      }),
    );
    expect(mocks.withWritablePrCheckout).not.toHaveBeenCalled();
  });

  it("resumes a stored not-needed push without rerunning the agent", async () => {
    const payload = {
      verdicts: [{ verdict: "skipped" as const, threadRootCommentId: 1, reason: "later" }],
    };
    mocks.getCompletedPublishStepDetail.mockResolvedValue({
      pushOutcome: "not-needed",
      pushedShas: [],
      commits: [],
      pushedHeadSha: "a".repeat(40),
      payload,
    });

    await executeTriageJob(cfg, pool, boss, job());

    expect(mocks.withWritablePrCheckout).not.toHaveBeenCalled();
    expect(mocks.runFullPrTriage).not.toHaveBeenCalled();
    expect(mocks.publishTriage).toHaveBeenCalledWith(
      expect.objectContaining({
        payload,
        priorPush: expect.objectContaining({ pushOutcome: "not-needed" }),
      }),
    );
  });

  it("maps stale pushOutcome to durable degraded without a missing mapping", async () => {
    let executeResult: unknown;
    mocks.runDurableWorkItem.mockImplementation(async (spec: DurableJobSpec<"triage">) => {
      executeResult = await spec.execute(item(), {
        prSurface: fakeDurablePrSurface(),
        headSha: "a".repeat(40),
        leaseEpoch: 1,
        signal: new AbortController().signal,
      });
    });
    mocks.publishTriage.mockResolvedValue({
      pushOutcome: "stale",
      missingThreadAction: false,
    });

    await executeTriageJob(cfg, pool, boss, job());

    expect(executeResult).toEqual({ kind: "completed", degraded: true });
    expect(mocks.publishTriage).toHaveBeenCalled();
  });

  it("maps missing thread actions to durable degraded without rewriting pushOutcome", async () => {
    let executeResult: unknown;
    mocks.runDurableWorkItem.mockImplementation(async (spec: DurableJobSpec<"triage">) => {
      executeResult = await spec.execute(item(), {
        prSurface: fakeDurablePrSurface(),
        headSha: "a".repeat(40),
        leaseEpoch: 1,
        signal: new AbortController().signal,
      });
    });
    mocks.publishTriage.mockResolvedValue({
      pushOutcome: "pushed",
      missingThreadAction: true,
    });

    await executeTriageJob(cfg, pool, boss, job());

    expect(executeResult).toEqual({ kind: "completed", degraded: true });
    await expect(mocks.publishTriage.mock.results[0]?.value).resolves.toEqual({
      pushOutcome: "pushed",
      missingThreadAction: true,
    });
  });

  it("keeps a successful not-needed publish as completed without degraded", async () => {
    let executeResult: unknown;
    mocks.runDurableWorkItem.mockImplementation(async (spec: DurableJobSpec<"triage">) => {
      executeResult = await spec.execute(item(), {
        prSurface: fakeDurablePrSurface(),
        headSha: "a".repeat(40),
        leaseEpoch: 1,
        signal: new AbortController().signal,
      });
    });
    mocks.publishTriage.mockResolvedValue({
      pushOutcome: "not-needed",
      missingThreadAction: false,
    });

    await executeTriageJob(cfg, pool, boss, job());

    expect(executeResult).toEqual({ kind: "completed" });
  });

  it("posts terminal failure comment when no report exists", async () => {
    mocks.runDurableWorkItem.mockImplementation(async (spec: DurableJobSpec<"triage">) => {
      await spec.onTerminalFailure?.(item(), fakeDurablePrSurface(), new Error("boom"));
    });

    await executeTriageJob(cfg, pool, boss, job());

    expect(durablePrSurfaceControls().replies).toHaveLength(1);
    expect(durablePrSurfaceControls().replies[0]?.body).toBe(TRIAGE_FAILURE_MESSAGE);
  });

  it("preview publishes a conversation comment and never pushes or mutates threads", async () => {
    const push = vi.fn();
    const committed = [
      {
        sha: "c".repeat(40),
        subject: "fix: app",
        diff: "diff --git a/src/app.ts b/src/app.ts\n+ok\n",
      },
    ];
    mocks.withWritablePrCheckout.mockImplementation(async (_params, run) =>
      run({
        dir: "/tmp/checkout",
        headRef: "branch",
        baseSha: "a".repeat(40),
        commit: vi.fn(),
        push,
        listCommittedShas: () => committed.map((entry) => entry.sha),
        listCommittedDetails: () => committed,
      }),
    );
    mocks.runFullPrTriage.mockResolvedValue({
      submitted: true,
      payload: {
        verdicts: [
          {
            verdict: "fixed",
            threadRootCommentId: 1,
            commitSha: "c".repeat(40),
            evidence: "fixed",
          },
        ],
      },
      commitByThreadRootCommentId: new Map([[1, "c".repeat(40)]]),
      commitErrors: [],
    });
    mockDurableExecution(item({ payload: { mode: "preview" } }));

    const repliesBefore = durablePrSurfaceControls().replies.length;
    const resolveBefore = durablePrSurfaceControls().events.filter(
      (event) => event.kind === "resolveInlineReviewThread",
    ).length;

    await executeTriageJob(cfg, pool, boss, job());

    expect(mocks.publishTriage).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(mocks.publishTriagePreview).toHaveBeenCalled();
    expect(mocks.recordPublishStep).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        step: "triage_preview",
        detail: expect.objectContaining({
          headSha: "a".repeat(40),
          threadRootCommentIds: [1],
          payload: expect.objectContaining({
            verdicts: [expect.objectContaining({ threadRootCommentId: 1, verdict: "fixed" })],
          }),
        }),
      }),
    );
    expect(
      durablePrSurfaceControls().events.some(
        (event) =>
          event.kind === "upsertProgressComment" && event.sentinel === TRIAGE_PREVIEW_SENTINEL,
      ),
    ).toBe(true);
    expect(durablePrSurfaceControls().replies).toHaveLength(repliesBefore);
    expect(
      durablePrSurfaceControls().events.filter(
        (event) => event.kind === "resolveInlineReviewThread",
      ),
    ).toHaveLength(resolveBefore);
  });

  it("bulk without a preview refuses report-only and never checks out", async () => {
    mockDurableExecution(item({ payload: { mode: "bulk" } }));
    mocks.getLatestCompletedPublishStepDetail.mockResolvedValue(null);
    mocks.parseStoredTriagePreviewDetail.mockReturnValue(null);

    await executeTriageJob(cfg, pool, boss, job());

    expect(mocks.publishTriageReportOnly).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining(TRIAGE_BULK_REQUIRES_PREVIEW),
      }),
    );
    expect(mocks.withWritablePrCheckout).not.toHaveBeenCalled();
    expect(mocks.runFullPrTriage).not.toHaveBeenCalled();
  });

  it("bulk with a preview for another headSha refuses", async () => {
    mockDurableExecution(item({ payload: { mode: "bulk" } }));
    mocks.getLatestCompletedPublishStepDetail.mockResolvedValue(
      storedPreview({ headSha: "b".repeat(40) }),
    );
    mocks.parseStoredTriagePreviewDetail.mockReturnValue(
      storedPreview({ headSha: "b".repeat(40) }),
    );

    await executeTriageJob(cfg, pool, boss, job());

    expect(mocks.publishTriageReportOnly).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining(TRIAGE_BULK_PREVIEW_STALE),
      }),
    );
    expect(mocks.withWritablePrCheckout).not.toHaveBeenCalled();
  });

  it("bulk with exclude replays only the remaining preview hunks", async () => {
    durablePrSurfaceControls().setBotFindingThreads([
      {
        rootCommentId: 1,
        lens: "review",
        path: "src/app.ts",
        line: 1,
        severity: "P1",
        titleSnippet: "P1 · One",
        humanReplies: [],
        threadUrl: "https://github.test/1",
      },
      {
        rootCommentId: 2,
        lens: "review",
        path: "src/b.ts",
        line: 2,
        severity: "P2",
        titleSnippet: "P2 · Two",
        humanReplies: [],
        threadUrl: "https://github.test/2",
      },
    ]);
    configureDefaultThreads([
      [1, { threadNodeId: "n1", isResolved: false }],
      [2, { threadNodeId: "n2", isResolved: false }],
    ]);
    mockDurableExecution(
      item({
        payload: { mode: "bulk", excludeThreadRootCommentIds: [2] },
      }),
    );
    mocks.parseStoredTriagePreviewDetail.mockReturnValue(
      storedPreview({ threadRootCommentIds: [1, 2] }),
    );
    mocks.getLatestCompletedPublishStepDetail.mockResolvedValue(
      storedPreview({ threadRootCommentIds: [1, 2] }),
    );

    await executeTriageJob(cfg, pool, boss, job());

    expect(mocks.runFullPrTriage).not.toHaveBeenCalled();
    expect(mocks.replayPreviewHunks).toHaveBeenCalledWith(
      expect.objectContaining({
        hunks: [expect.objectContaining({ threadRootCommentId: 1 })],
      }),
    );
    expect(mocks.publishTriage).toHaveBeenCalled();
  });

  it("bulk happy path calls publishTriage", async () => {
    mockDurableExecution(item({ payload: { mode: "bulk" } }));
    mocks.parseStoredTriagePreviewDetail.mockReturnValue(storedPreview());
    mocks.getLatestCompletedPublishStepDetail.mockResolvedValue(storedPreview());

    await executeTriageJob(cfg, pool, boss, job());

    expect(mocks.withWritablePrCheckout).toHaveBeenCalled();
    expect(mocks.runFullPrTriage).not.toHaveBeenCalled();
    expect(mocks.replayPreviewHunks).toHaveBeenCalled();
    expect(mocks.publishTriage).toHaveBeenCalled();
    expect(mocks.publishTriagePreview).not.toHaveBeenCalled();
  });

  it("skips a second apply or bulk run when triage_report already completed", async () => {
    mocks.hasCompletedPublishStep.mockResolvedValue(true);
    mockDurableExecution(item({ payload: { mode: "bulk" } }));
    mocks.parseStoredTriagePreviewDetail.mockReturnValue(storedPreview());
    mocks.getLatestCompletedPublishStepDetail.mockResolvedValue(storedPreview());

    await executeTriageJob(cfg, pool, boss, job());

    expect(mocks.withWritablePrCheckout).not.toHaveBeenCalled();
    expect(mocks.publishTriage).not.toHaveBeenCalled();
  });
});
