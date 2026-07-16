import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { DurableJobSpec } from "../src/agentWork/durableJob.js";
import type { VerificationJobData } from "../src/agentWork/types.js";
import { makeTestConfig } from "./helpers/config.js";

const mocks = vi.hoisted(() => ({
  runDurableWorkItem: vi.fn(),
  getAppBotIdentity: vi.fn(),
  fetchBotFindingThreads: vi.fn(),
  listReviewThreadResolution: vi.fn(),
  withPrRepositoryView: vi.fn(),
  runVerification: vi.fn(),
  publishVerification: vi.fn(),
  fetchPullRequestFiles: vi.fn(),
  listTriageEligibleInlineReviews: vi.fn(),
  listCommits: vi.fn(),
  createReplyForReviewComment: vi.fn(),
  resolveReviewThread: vi.fn(),
  recordPublishStep: vi.fn(),
}));

vi.mock("../src/agentWork/durableJob.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agentWork/durableJob.js")>();
  return { ...actual, runDurableWorkItem: mocks.runDurableWorkItem };
});

vi.mock("../src/github/appAuth.js", () => ({
  getAppBotIdentity: mocks.getAppBotIdentity,
  installationOctokit: vi.fn(() => ({
    rest: {
      pulls: {
        listCommits: mocks.listCommits,
        createReplyForReviewComment: mocks.createReplyForReviewComment,
      },
    },
  })),
}));

vi.mock("../src/review/run/reviewPriorFeedback.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/review/run/reviewPriorFeedback.js")>();
  return { ...actual, fetchBotFindingThreads: mocks.fetchBotFindingThreads };
});

vi.mock("../src/github/reviewThreadResolution.js", () => ({
  listReviewThreadResolution: mocks.listReviewThreadResolution,
  resolveReviewThread: mocks.resolveReviewThread,
}));

vi.mock("../src/prWorkspace/index.js", () => ({
  withPrRepositoryView: mocks.withPrRepositoryView,
}));

vi.mock("../src/agent/verification/verificationRun.js", () => ({
  runVerification: mocks.runVerification,
}));

vi.mock("../src/agent/verification/publishVerification.js", () => ({
  publishVerification: mocks.publishVerification,
}));

vi.mock("../src/github/listPullRequestFiles.js", () => ({
  fetchPullRequestFiles: mocks.fetchPullRequestFiles,
}));

vi.mock("../src/agentWork/repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agentWork/repository.js")>();
  return { ...actual, listTriageEligibleInlineReviews: mocks.listTriageEligibleInlineReviews };
});

import { executeVerificationJob } from "../src/agentWork/executors/verificationExecutor.js";
import { makeVerificationWorkItem } from "./helpers/agentWorkItems.js";

const cfg = makeTestConfig();
const pool = {} as Pool;
const boss = {} as PgBoss;

function item(overrides: Parameters<typeof makeVerificationWorkItem>[0] = {}) {
  return makeVerificationWorkItem({
    headSha: "a".repeat(40),
    payload: { repositorySizeKb: 100 },
    ...overrides,
  });
}

function job(): JobWithMetadata<VerificationJobData> {
  return {
    data: { kind: "verification", workItemId: "wi-1" },
  } as JobWithMetadata<VerificationJobData>;
}

function mockDurableExecution(workItem = item()): void {
  mocks.runDurableWorkItem.mockImplementation(async (spec: DurableJobSpec<"verification">) =>
    spec.execute(workItem, {
      installation: { token: "tok", expiresAtTs: Date.now() + 60_000, ttlMs: 60_000 },
      headSha: "a".repeat(40),
    }),
  );
}

function findingThread(
  rootCommentId: number,
  overrides: Partial<{
    path: string;
    line: number;
    severity: string;
    titleSnippet: string;
    humanReplies: string[];
    hasTriageReply: boolean;
  }> = {},
) {
  return {
    rootCommentId,
    lens: "review" as const,
    path: "src/app.ts",
    line: 1,
    severity: "P1" as const,
    titleSnippet: "P1 · Bug",
    humanReplies: [] as string[],
    threadUrl: "https://github.test/thread",
    ...overrides,
  };
}

describe("executeVerificationJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDurableExecution();
    mocks.getAppBotIdentity.mockResolvedValue({ userId: 999, login: "pr-agent[bot]" });
    mocks.fetchBotFindingThreads.mockResolvedValue([]);
    mocks.listReviewThreadResolution.mockResolvedValue(new Map());
    mocks.withPrRepositoryView.mockImplementation(
      async (_params: unknown, run: (view: unknown) => Promise<unknown>) =>
        run({ agentCwd: "/tmp/view", workspace: {}, preflight: {} }),
    );
    mocks.runVerification.mockResolvedValue({
      submitted: true,
      payload: { verdicts: [] },
    });
    mocks.publishVerification.mockResolvedValue({ degraded: false });
    mocks.fetchPullRequestFiles.mockResolvedValue({
      files: [{ filename: "src/app.ts" }],
      truncated: false,
      omittedCountLowerBound: 0,
      totalChanges: 10,
      headSha: "a".repeat(40),
    });
    mocks.listTriageEligibleInlineReviews.mockResolvedValue(new Map());
    mocks.listCommits.mockResolvedValue({
      data: [{ sha: "b".repeat(40), commit: { message: "fix: guard user" } }],
    });
  });

  it("short-circuits quietly when there are no open findings", async () => {
    mocks.fetchBotFindingThreads.mockResolvedValue([]);

    await executeVerificationJob(cfg, pool, boss, job());

    expect(mocks.withPrRepositoryView).not.toHaveBeenCalled();
    expect(mocks.runVerification).not.toHaveBeenCalled();
    expect(mocks.publishVerification).not.toHaveBeenCalled();
  });

  it("short-circuits when all findings are already resolved", async () => {
    mocks.fetchBotFindingThreads.mockResolvedValue([findingThread(1, { path: "src/app.ts" })]);
    mocks.listReviewThreadResolution.mockResolvedValue(
      new Map([[1, { threadNodeId: "node", isResolved: true }]]),
    );

    await executeVerificationJob(cfg, pool, boss, job());

    expect(mocks.withPrRepositoryView).not.toHaveBeenCalled();
    expect(mocks.runVerification).not.toHaveBeenCalled();
    expect(mocks.publishVerification).not.toHaveBeenCalled();
  });

  it("runs the verification agent and publishes when there are open findings", async () => {
    mocks.fetchBotFindingThreads.mockResolvedValue([findingThread(1, { path: "src/app.ts" })]);
    mocks.listReviewThreadResolution.mockResolvedValue(
      new Map([[1, { threadNodeId: "node", isResolved: false }]]),
    );
    mocks.runVerification.mockResolvedValue({
      submitted: true,
      payload: {
        verdicts: [
          {
            verdict: "fixed",
            threadRootCommentId: 1,
            commitSha: "b".repeat(40),
            evidence: "fixed",
          },
        ],
      },
    });

    await executeVerificationJob(cfg, pool, boss, job());

    expect(mocks.withPrRepositoryView).toHaveBeenCalled();
    expect(mocks.runVerification).toHaveBeenCalledWith(
      expect.objectContaining({
        inventory: [expect.objectContaining({ rootCommentId: 1 })],
        pushedCommits: expect.arrayContaining([expect.objectContaining({ sha: "b".repeat(40) })]),
      }),
    );
    expect(mocks.publishVerification).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          verdicts: expect.arrayContaining([expect.objectContaining({ verdict: "fixed" })]),
        }),
        changedFilePaths: ["src/app.ts"],
      }),
    );
  });

  it("passes changed file paths for the skipped-reply noise bound", async () => {
    mocks.fetchBotFindingThreads.mockResolvedValue([
      findingThread(1, { path: "src/app.ts" }),
      findingThread(2, { path: "src/other.ts" }),
    ]);
    mocks.listReviewThreadResolution.mockResolvedValue(
      new Map([
        [1, { threadNodeId: "node-1", isResolved: false }],
        [2, { threadNodeId: "node-2", isResolved: false }],
      ]),
    );
    mocks.fetchPullRequestFiles.mockResolvedValue({
      files: [{ filename: "src/app.ts" }, { filename: "README.md" }],
      truncated: false,
      omittedCountLowerBound: 0,
      totalChanges: 20,
      headSha: "a".repeat(40),
    });
    mocks.runVerification.mockResolvedValue({
      submitted: true,
      payload: {
        verdicts: [
          {
            verdict: "skipped",
            threadRootCommentId: 1,
            reason: "still open",
          },
          {
            verdict: "skipped",
            threadRootCommentId: 2,
            reason: "still open",
          },
        ],
      },
    });

    await executeVerificationJob(cfg, pool, boss, job());

    expect(mocks.publishVerification).toHaveBeenCalledWith(
      expect.objectContaining({
        changedFilePaths: ["src/app.ts", "README.md"],
      }),
    );
  });

  it("throws when the agent does not submit a payload", async () => {
    mocks.fetchBotFindingThreads.mockResolvedValue([findingThread(1, { path: "src/app.ts" })]);
    mocks.listReviewThreadResolution.mockResolvedValue(
      new Map([[1, { threadNodeId: "node", isResolved: false }]]),
    );
    mocks.runVerification.mockResolvedValue({
      submitted: false,
      payload: null,
    });

    await expect(executeVerificationJob(cfg, pool, boss, job())).rejects.toThrow(
      "Verification run ended without submitVerification",
    );
    expect(mocks.publishVerification).not.toHaveBeenCalled();
  });

  it("propagates degraded when publishVerification reports degraded", async () => {
    mocks.fetchBotFindingThreads.mockResolvedValue([findingThread(1, { path: "src/app.ts" })]);
    mocks.listReviewThreadResolution.mockResolvedValue(
      new Map([[1, { threadNodeId: "node", isResolved: false }]]),
    );
    mocks.runVerification.mockResolvedValue({
      submitted: true,
      payload: {
        verdicts: [
          {
            verdict: "fixed",
            threadRootCommentId: 1,
            commitSha: "b".repeat(40),
            evidence: "fixed",
          },
        ],
      },
    });
    mocks.publishVerification.mockResolvedValue({ degraded: true });

    let executeResult: unknown;
    mocks.runDurableWorkItem.mockImplementation(async (spec: DurableJobSpec<"verification">) => {
      executeResult = await spec.execute(item(), {
        installation: { token: "tok", expiresAtTs: Date.now() + 60_000, ttlMs: 60_000 },
        headSha: "a".repeat(40),
      });
    });

    await executeVerificationJob(cfg, pool, boss, job());

    expect(executeResult).toEqual({ degraded: true });
  });
});
