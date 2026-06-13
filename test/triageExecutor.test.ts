import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { DurableJobSpec } from "../src/agentWork/durableJob.js";
import type { AgentWorkItem, TriageJobData } from "../src/agentWork/types.js";
import { TRIAGE_FAILURE_MESSAGE } from "../src/settings/index.js";
import { makeTestConfig } from "./helpers/config.js";

const mocks = vi.hoisted(() => ({
  runDurableWorkItem: vi.fn(),
  pullsGet: vi.fn(),
  createComment: vi.fn(),
  getAppBotIdentity: vi.fn(),
  fetchBotFindingThreads: vi.fn(),
  listReviewThreadResolution: vi.fn(),
  withWritablePrCheckout: vi.fn(),
  runFullPrTriage: vi.fn(),
  publishTriage: vi.fn(),
  publishTriageReportOnly: vi.fn(),
  hasCompletedPublishStep: vi.fn(),
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

vi.mock("../src/review/reviewPriorFeedback.js", () => ({
  fetchBotFindingThreads: mocks.fetchBotFindingThreads,
}));

vi.mock("../src/github/reviewThreadResolution.js", () => ({
  listReviewThreadResolution: mocks.listReviewThreadResolution,
}));

vi.mock("../src/prWorkspace/index.js", () => ({
  withWritablePrCheckout: mocks.withWritablePrCheckout,
}));

vi.mock("../src/agent/triageRun.js", () => ({
  runFullPrTriage: mocks.runFullPrTriage,
}));

vi.mock("../src/agent/publishTriage.js", () => ({
  publishTriage: mocks.publishTriage,
  publishTriageReportOnly: mocks.publishTriageReportOnly,
}));

vi.mock("../src/agentWork/repository.js", () => ({
  hasCompletedPublishStep: mocks.hasCompletedPublishStep,
}));

import { executeTriageJob } from "../src/agentWork/executors/triageExecutor.js";

const cfg = makeTestConfig();
const pool = {} as Pool;
const boss = {} as PgBoss;

function item(): AgentWorkItem {
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
    payload: { source: "slash", commentId: 5 },
    cancelRequestedAt: null,
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
    mocks.publishTriage.mockResolvedValue({ degraded: false });
    mocks.publishTriageReportOnly.mockResolvedValue(undefined);
    mocks.hasCompletedPublishStep.mockResolvedValue(false);
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
