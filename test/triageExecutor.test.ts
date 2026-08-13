import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { PgBoss } from "pg-boss";
import type { JobWithMetadata } from "pg-boss";
import type { TriageJobData, TriageWorkItem, TriageWorkPayload } from "../src/agentWork/types.js";
import {
  TRIAGE_ALL_PRIOR_FINDINGS_RESOLVED,
  TRIAGE_FAILURE_MESSAGE,
  TRIAGE_THREAD_NOT_ELIGIBLE,
} from "../src/settings/index.js";
import { makeTestConfig } from "./helpers/config.js";
import {
  durablePrSurfaceControls,
  fakeDurablePrSurface,
  makeDurableJobMetadata,
  resetDurablePrSurface,
} from "./helpers/executorDurableHarness.js";
import { resetCreatePrSurface, setCreatePrSurface } from "../src/github/prSurface.js";
import { executeTriageJob } from "../src/agentWork/executors/triageExecutor.js";
import { makeTriageWorkItem } from "./helpers/agentWorkItems.js";
import * as durableJob from "../src/agentWork/durableJob.js";
import * as appAuth from "../src/github/appAuth.js";
import * as reviewThreadResolution from "../src/github/reviewThreadResolution.js";
import * as prWorkspace from "../src/prWorkspace/index.js";
import * as triageRun from "../src/agent/triage/triageRun.js";
import * as publishTriage from "../src/agent/triage/publishTriage.js";
import * as repo from "../src/agentWork/repository.js";
import type { WritablePrCheckout } from "../src/prWorkspace/writablePrCheckout.js";
import type { TriageRunResult } from "../src/agent/triage/triageRun.js";
import { assistantFromText } from "../src/agentRun/sessionHelpers.js";

const cfg = makeTestConfig();
const pool = new Pool({ connectionString: "postgres://127.0.0.1:1/unused" });
const boss = new PgBoss({ connectionString: "postgres://127.0.0.1:1/unused" });

type TriageItemOverrides = Omit<
  Partial<TriageWorkItem>,
  "type" | "payload" | "reviewLens" | "source"
> & {
  payload?: Partial<TriageWorkPayload>;
};

function fakeCheckout(): WritablePrCheckout {
  return {
    dir: "/tmp/checkout",
    headRef: "branch",
    baseSha: "a".repeat(40),
    commit: vi.fn(),
    push: vi.fn(),
    listCommittedShas: () => [],
    listCommittedDetails: () => [],
  };
}

function triageResult(overrides: Partial<TriageRunResult> = {}): TriageRunResult {
  return {
    submitted: true,
    payload: { verdicts: [{ verdict: "skipped", threadRootCommentId: 1, reason: "later" }] },
    lastAssistant: assistantFromText(cfg, "", cfg.piProvider),
    commitByThreadRootCommentId: new Map(),
    ...overrides,
  };
}

function item(overrides: TriageItemOverrides = {}) {
  return makeTriageWorkItem({ headSha: "head", ...overrides });
}

function job(): JobWithMetadata<TriageJobData> {
  return {
    ...makeDurableJobMetadata("wi-1"),
    name: "agent-work-triage",
    data: { kind: "triage", workItemId: "wi-1" },
  };
}

function mockDurableExecution(workItem = item()): void {
  vi.mocked(durableJob.runDurableWorkItem).mockImplementation(async (spec) => {
    if (spec.type !== "triage") return;
    await spec.execute(workItem, {
      prSurface: fakeDurablePrSurface(),
      headSha: "a".repeat(40),
      executionEpoch: 1,
      signal: new AbortController().signal,
    });
  });
}

function configureDefaultThreads(
  entries: ReadonlyArray<readonly [number, { threadNodeId: string; isResolved: boolean }]>,
) {
  durablePrSurfaceControls().setThreads(new Map(entries));
}

describe("executeTriageJob", () => {
  beforeEach(() => {
    resetDurablePrSurface();
    setCreatePrSurface(() => fakeDurablePrSurface());
    vi.spyOn(durableJob, "runDurableWorkItem");
    mockDurableExecution();
    vi.spyOn(appAuth, "getAppBotIdentity").mockResolvedValue({
      userId: 999,
      login: "pr-agent[bot]",
    });
    vi.spyOn(reviewThreadResolution, "warnReviewThreadResolutionDegraded").mockImplementation(
      () => undefined,
    );
    vi.spyOn(prWorkspace, "withWritablePrCheckout").mockImplementation(async (_params, run) =>
      run(fakeCheckout()),
    );
    vi.spyOn(triageRun, "runFullPrTriage").mockResolvedValue(triageResult());
    vi.spyOn(publishTriage, "publishTriage").mockResolvedValue({ degraded: false });
    vi.spyOn(publishTriage, "publishTriageReportOnly").mockResolvedValue(undefined);
    vi.spyOn(repo, "getCompletedPublishStepDetail").mockResolvedValue(null);
    vi.spyOn(repo, "getCompletedPublishStepDetailWithoutNewerStep").mockResolvedValue(null);
    vi.spyOn(repo, "hasCompletedPublishStep").mockResolvedValue(false);
    vi.spyOn(repo, "listTriageEligibleInlineReviews").mockResolvedValue(new Map());
    configureDefaultThreads([[1, { threadNodeId: "node", isResolved: false }]]);
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
    durablePrSurfaceControls().setReviewCommentParentGraph([]);
    durablePrSurfaceControls().setGithubUser(42, {
      id: 42,
      login: "alice",
      name: "Alice",
      email: null,
      type: "User",
    });
  });

  afterEach(() => {
    resetCreatePrSurface();
    vi.restoreAllMocks();
  });

  it("runs triage and publishes", async () => {
    await executeTriageJob(cfg, pool, boss, job());

    expect(prWorkspace.withWritablePrCheckout).toHaveBeenCalled();
    expect(triageRun.runFullPrTriage).toHaveBeenCalled();
    expect(publishTriage.publishTriage).toHaveBeenCalled();
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
    expect(prWorkspace.withWritablePrCheckout).toHaveBeenCalledWith(
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
    expect(prWorkspace.withWritablePrCheckout).toHaveBeenCalledWith(
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

    expect(prWorkspace.withWritablePrCheckout).toHaveBeenCalledWith(
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

    expect(vi.mocked(publishTriage.publishTriageReportOnly)).toHaveBeenCalled();
    expect(prWorkspace.withWritablePrCheckout).not.toHaveBeenCalled();
  });

  it("reports already-resolved threads without implying no review ran", async () => {
    configureDefaultThreads([[1, { threadNodeId: "node", isResolved: true }]]);

    await executeTriageJob(cfg, pool, boss, job());

    expect(vi.mocked(publishTriage.publishTriageReportOnly)).toHaveBeenCalledWith(
      expect.objectContaining({
        inventory: [],
        previouslyResolvedCount: 1,
        body: expect.stringContaining(TRIAGE_ALL_PRIOR_FINDINGS_RESOLVED),
      }),
    );
    expect(vi.mocked(publishTriage.publishTriageReportOnly).mock.calls[0]?.[0].body).toContain(
      "Inventory items: 1",
    );
    expect(vi.mocked(publishTriage.publishTriageReportOnly).mock.calls[0]?.[0].body).toContain(
      "Previously resolved: 1",
    );
    expect(prWorkspace.withWritablePrCheckout).not.toHaveBeenCalled();
  });

  it("resumes publish from stored push detail without rerunning agent", async () => {
    const payload = {
      verdicts: [{ verdict: "skipped" as const, threadRootCommentId: 1, reason: "later" }],
    };
    vi.mocked(repo.getCompletedPublishStepDetail).mockResolvedValue({
      pushedShas: ["abc1234"],
      commits: [{ sha: "abc1234", subject: "fix: guard user", diff: "+ok\n" }],
      pushedHeadSha: "a".repeat(40),
      payload,
    });

    await executeTriageJob(cfg, pool, boss, job());

    expect(prWorkspace.withWritablePrCheckout).not.toHaveBeenCalled();
    expect(triageRun.runFullPrTriage).not.toHaveBeenCalled();
    expect(publishTriage.publishTriage).toHaveBeenCalledWith(
      expect.objectContaining({
        payload,
        priorPush: expect.objectContaining({ pushed: true, degraded: false }),
      }),
    );
  });

  it("runs a fresh agent pass when same-work-item push detail is stale", async () => {
    vi.mocked(repo.getCompletedPublishStepDetail).mockResolvedValue({
      staleHead: true,
      attemptedShas: ["abc1234"],
      commits: [{ sha: "abc1234", subject: "fix: guard user", diff: "+ok\n" }],
      payload: {
        verdicts: [{ verdict: "skipped" as const, threadRootCommentId: 1, reason: "later" }],
      },
    });

    await executeTriageJob(cfg, pool, boss, job());

    expect(prWorkspace.withWritablePrCheckout).toHaveBeenCalled();
    expect(triageRun.runFullPrTriage).toHaveBeenCalled();
  });

  it("runs a fresh agent pass when same-work-item push detail has stale head", async () => {
    vi.mocked(repo.getCompletedPublishStepDetail).mockResolvedValue({
      pushedShas: ["abc1234"],
      commits: [{ sha: "abc1234", subject: "fix: guard user", diff: "+ok\n" }],
      pushedHeadSha: "b".repeat(40),
      payload: {
        verdicts: [{ verdict: "skipped" as const, threadRootCommentId: 1, reason: "later" }],
      },
    });

    await executeTriageJob(cfg, pool, boss, job());

    expect(prWorkspace.withWritablePrCheckout).toHaveBeenCalled();
    expect(triageRun.runFullPrTriage).toHaveBeenCalled();
  });

  it("resumes latest unreported push from a prior triage work item", async () => {
    const payload = {
      verdicts: [{ verdict: "skipped" as const, threadRootCommentId: 1, reason: "later" }],
    };
    vi.mocked(repo.getCompletedPublishStepDetailWithoutNewerStep).mockResolvedValue({
      pushedShas: ["abc1234"],
      commits: [{ sha: "abc1234", subject: "fix: guard user", diff: "+ok\n" }],
      pushedHeadSha: "a".repeat(40),
      payload,
    });

    await executeTriageJob(cfg, pool, boss, job());

    expect(prWorkspace.withWritablePrCheckout).not.toHaveBeenCalled();
    expect(triageRun.runFullPrTriage).not.toHaveBeenCalled();
    expect(publishTriage.publishTriage).toHaveBeenCalledWith(
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
    vi.mocked(repo.getCompletedPublishStepDetailWithoutNewerStep).mockResolvedValue({
      pushedShas: ["abc1234"],
      commits: [{ sha: "abc1234", subject: "fix: guard user", diff: "+ok\n" }],
      pushedHeadSha: "a".repeat(40),
      payload: {
        verdicts: [{ verdict: "skipped" as const, threadRootCommentId: 1, reason: "later" }],
      },
    });

    await executeTriageJob(cfg, pool, boss, job());

    expect(prWorkspace.withWritablePrCheckout).toHaveBeenCalled();
    expect(triageRun.runFullPrTriage).toHaveBeenCalled();
  });

  it("runs a fresh agent pass when cross-work-item push detail has extra verdicts", async () => {
    vi.mocked(repo.getCompletedPublishStepDetailWithoutNewerStep).mockResolvedValue({
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

    expect(prWorkspace.withWritablePrCheckout).toHaveBeenCalled();
    expect(triageRun.runFullPrTriage).toHaveBeenCalled();
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

    expect(triageRun.runFullPrTriage).toHaveBeenCalledWith(
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

    expect(triageRun.runFullPrTriage).toHaveBeenCalledWith(
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

    expect(vi.mocked(publishTriage.publishTriageReportOnly)).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining(TRIAGE_THREAD_NOT_ELIGIBLE),
      }),
    );
    expect(prWorkspace.withWritablePrCheckout).not.toHaveBeenCalled();
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

    expect(vi.mocked(publishTriage.publishTriageReportOnly)).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining(TRIAGE_ALL_PRIOR_FINDINGS_RESOLVED),
      }),
    );
    expect(vi.mocked(publishTriage.publishTriageReportOnly).mock.calls[0]?.[0].body).not.toContain(
      TRIAGE_THREAD_NOT_ELIGIBLE,
    );
    expect(prWorkspace.withWritablePrCheckout).not.toHaveBeenCalled();
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
    expect(vi.mocked(publishTriage.publishTriageReportOnly)).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining(TRIAGE_THREAD_NOT_ELIGIBLE),
      }),
    );
    expect(prWorkspace.withWritablePrCheckout).not.toHaveBeenCalled();
  });

  it("posts terminal failure comment when no report exists", async () => {
    vi.mocked(durableJob.runDurableWorkItem).mockImplementation(async (spec) => {
      if (spec.type !== "triage") return;
      await spec.onTerminalFailure?.(item(), fakeDurablePrSurface(), new Error("boom"));
    });

    await executeTriageJob(cfg, pool, boss, job());

    expect(durablePrSurfaceControls().replies).toHaveLength(1);
    expect(durablePrSurfaceControls().replies[0]?.body).toBe(TRIAGE_FAILURE_MESSAGE);
  });
});
