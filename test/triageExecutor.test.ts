import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { DurableJobSpec } from "../src/agentWork/durableJob.js";
import type { AgentWorkItem, TriageJobData } from "../src/agentWork/types.js";
import {
  TRIAGE_ALL_PRIOR_FINDINGS_RESOLVED,
  TRIAGE_FAILURE_MESSAGE,
  TRIAGE_THREAD_NOT_ELIGIBLE,
} from "../src/settings/index.js";
import { makeTestConfig } from "./helpers/config.js";

const mocks = vi.hoisted(() => ({
  runDurableWorkItem: vi.fn(),
  pullsGet: vi.fn(),
  createComment: vi.fn(),
  getAppBotIdentity: vi.fn(),
  fetchBotFindingThreads: vi.fn(),
  fetchReviewCommentParentGraph: vi.fn(),
  listReviewThreadResolution: vi.fn(),
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
  installationOctokit: vi.fn(() => ({
    rest: {
      pulls: { get: mocks.pullsGet },
      issues: { createComment: mocks.createComment },
    },
  })),
}));

vi.mock("../src/review/run/reviewPriorFeedback.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/review/run/reviewPriorFeedback.js")>();
  return {
    ...actual,
    fetchBotFindingThreads: mocks.fetchBotFindingThreads,
    fetchReviewCommentParentGraph: mocks.fetchReviewCommentParentGraph,
  };
});

vi.mock("../src/github/reviewThreadResolution.js", () => ({
  listReviewThreadResolution: mocks.listReviewThreadResolution,
}));

vi.mock("../src/prWorkspace/index.js", () => ({
  withWritablePrCheckout: mocks.withWritablePrCheckout,
}));

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

const cfg = makeTestConfig();
const pool = {} as Pool;
const boss = {} as PgBoss;

function item(overrides: Partial<AgentWorkItem> = {}): AgentWorkItem {
  return {
    id: "wi-1",
    webhookEventId: "ev-1",
    type: "triage",
    source: "slash",
    status: "running",
    owner: "o",
    repo: "r",
    prNumber: 1,
    installationId: 42,
    headSha: "head",
    reviewLens: null,
    resourceKey: "o/r#1",
    attemptCount: 0,
    payload: {
      source: "slash",
      commentId: 5,
      scope: "all",
      replyTarget: { kind: "prConversation", prNumber: 1 },
    },
    cancelRequestedAt: null,
    ...overrides,
  };
}

function job(): JobWithMetadata<TriageJobData> {
  return {
    data: { kind: "triage", workItemId: "wi-1" },
  } as JobWithMetadata<TriageJobData>;
}

function mockDurableExecution(workItem = item()): void {
  mocks.runDurableWorkItem.mockImplementation(async (spec: DurableJobSpec) =>
    spec.execute(workItem, {
      installation: { token: "tok", expiresAtTs: Date.now() + 60_000, ttlMs: 60_000 },
      headSha: "a".repeat(40),
    }),
  );
}

describe("executeTriageJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDurableExecution();
    mocks.pullsGet.mockResolvedValue({
      data: {
        head: { ref: "branch", repo: { full_name: "o/r" } },
        base: { repo: { full_name: "o/r" } },
      },
    });
    mocks.getAppBotIdentity.mockResolvedValue({ userId: 999, login: "pr-agent[bot]" });
    mocks.fetchBotFindingThreads.mockResolvedValue([
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
    mocks.listReviewThreadResolution.mockResolvedValue(
      new Map([[1, { threadNodeId: "node", isResolved: false }]]),
    );
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
    mocks.fetchReviewCommentParentGraph.mockResolvedValue([]);
  });

  it("runs triage and publishes", async () => {
    await executeTriageJob(cfg, pool, boss, job());

    expect(mocks.withWritablePrCheckout).toHaveBeenCalled();
    expect(mocks.runFullPrTriage).toHaveBeenCalled();
    expect(mocks.publishTriage).toHaveBeenCalled();
  });

  it("fork PRs publish report only and never create checkout", async () => {
    mocks.pullsGet.mockResolvedValue({
      data: {
        head: { ref: "branch", repo: { full_name: "fork/r" } },
        base: { repo: { full_name: "o/r" } },
      },
    });

    await executeTriageJob(cfg, pool, boss, job());

    expect(mocks.publishTriageReportOnly).toHaveBeenCalled();
    expect(mocks.withWritablePrCheckout).not.toHaveBeenCalled();
  });

  it("reports already-resolved threads without implying no review ran", async () => {
    mocks.listReviewThreadResolution.mockResolvedValue(
      new Map([[1, { threadNodeId: "node", isResolved: true }]]),
    );

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
    mocks.fetchBotFindingThreads.mockResolvedValue([
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
    mocks.listReviewThreadResolution.mockResolvedValue(
      new Map([
        [1, { threadNodeId: "node-1", isResolved: false }],
        [2, { threadNodeId: "node-2", isResolved: false }],
      ]),
    );
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
    mocks.fetchBotFindingThreads.mockResolvedValue([
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
    mocks.listReviewThreadResolution.mockResolvedValue(
      new Map([
        [1, { threadNodeId: "node-1", isResolved: false }],
        [2, { threadNodeId: "node-2", isResolved: false }],
      ]),
    );
    mocks.fetchReviewCommentParentGraph.mockResolvedValue([
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
    expect(mocks.fetchReviewCommentParentGraph).toHaveBeenCalledTimes(1);
  });

  it("falls back to the original inline parent when thread-root resolution fails", async () => {
    mocks.fetchBotFindingThreads.mockResolvedValue([
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
    mocks.listReviewThreadResolution.mockResolvedValue(
      new Map([[9, { threadNodeId: "node-9", isResolved: false }]]),
    );
    mocks.fetchReviewCommentParentGraph.mockRejectedValue(new Error("graphql unavailable"));
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
    mocks.fetchBotFindingThreads.mockResolvedValue([
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
    mocks.fetchReviewCommentParentGraph.mockResolvedValue([{ id: 99, inReplyToId: null }]);
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
    mocks.fetchBotFindingThreads.mockResolvedValue([
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
    mocks.listReviewThreadResolution.mockResolvedValue(
      new Map([[1, { threadNodeId: "node-1", isResolved: true }]]),
    );
    mocks.fetchReviewCommentParentGraph.mockResolvedValue([
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
    mocks.fetchBotFindingThreads.mockResolvedValue([
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

    expect(mocks.fetchReviewCommentParentGraph).not.toHaveBeenCalled();
    expect(mocks.publishTriageReportOnly).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining(TRIAGE_THREAD_NOT_ELIGIBLE),
      }),
    );
    expect(mocks.withWritablePrCheckout).not.toHaveBeenCalled();
  });

  it("posts terminal failure comment when no report exists", async () => {
    mocks.runDurableWorkItem.mockImplementation(async (spec: DurableJobSpec) => {
      await spec.onTerminalFailure?.(
        item(),
        {
          token: "tok",
          expiresAtTs: Date.now() + 60_000,
          ttlMs: 60_000,
        },
        new Error("boom"),
      );
    });

    await executeTriageJob(cfg, pool, boss, job());

    expect(mocks.createComment).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      issue_number: 1,
      body: TRIAGE_FAILURE_MESSAGE,
    });
  });
});
