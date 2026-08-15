import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { DurableJobSpec } from "../src/agentWork/durableJob.js";
import type { TriageJobData } from "../src/agentWork/types.js";
import {
  TRIAGE_ALL_PRIOR_FINDINGS_RESOLVED,
  TRIAGE_FAILURE_MESSAGE,
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
  parseStoredTriagePushDetail: vi.fn(),
  publishTriage: vi.fn(),
  publishTriageReportOnly: vi.fn(),
  getCompletedPublishStepDetail: vi.fn(),
  getCompletedPublishStepDetailWithoutNewerStep: vi.fn(),
  hasCompletedPublishStep: vi.fn(),
  listTriageEligibleInlineReviews: vi.fn(),
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

vi.mock("../src/agent/triage/publishTriage.js", () => ({
  parseStoredTriagePushDetail: mocks.parseStoredTriagePushDetail,
  publishTriage: mocks.publishTriage,
  publishTriageReportOnly: mocks.publishTriageReportOnly,
}));

vi.mock("../src/agentWork/repository.js", () => ({
  getCompletedPublishStepDetail: mocks.getCompletedPublishStepDetail,
  getCompletedPublishStepDetailWithoutNewerStep:
    mocks.getCompletedPublishStepDetailWithoutNewerStep,
  hasCompletedPublishStep: mocks.hasCompletedPublishStep,
  listTriageEligibleInlineReviews: mocks.listTriageEligibleInlineReviews,
}));

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
    mocks.runFullPrTriage.mockResolvedValue({
      submitted: true,
      payload: { verdicts: [{ verdict: "skipped", threadRootCommentId: 1, reason: "later" }] },
    });
    mocks.parseStoredTriagePushDetail.mockImplementation((detail) => ({
      payload: detail.payload,
      commits: detail.commits,
      pushed: detail.staleHead !== true,
      degraded: detail.staleHead === true,
      pushedHeadSha: detail.pushedHeadSha,
    }));
    mocks.publishTriage.mockResolvedValue({ degraded: false });
    mocks.publishTriageReportOnly.mockResolvedValue(undefined);
    mocks.getCompletedPublishStepDetail.mockResolvedValue(null);
    mocks.getCompletedPublishStepDetailWithoutNewerStep.mockResolvedValue(null);
    mocks.hasCompletedPublishStep.mockResolvedValue(false);
    mocks.listTriageEligibleInlineReviews.mockResolvedValue(new Map());
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
        priorPush: expect.objectContaining({ pushed: true, degraded: false }),
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
        priorPush: expect.objectContaining({ pushed: true, degraded: false }),
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

  it("posts terminal failure comment when no report exists", async () => {
    mocks.runDurableWorkItem.mockImplementation(async (spec: DurableJobSpec<"triage">) => {
      await spec.onTerminalFailure?.(item(), fakeDurablePrSurface(), new Error("boom"));
    });

    await executeTriageJob(cfg, pool, boss, job());

    expect(durablePrSurfaceControls().replies).toHaveLength(1);
    expect(durablePrSurfaceControls().replies[0]?.body).toBe(TRIAGE_FAILURE_MESSAGE);
  });
});
