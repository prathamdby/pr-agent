import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { DurableJobSpec } from "../src/agentWork/durableJob.js";
import type { VerificationJobData } from "../src/agentWork/types.js";
import { makeTestConfig } from "./helpers/config.js";
import {
  durablePrSurfaceControls,
  fakeDurablePrSurface,
  resetDurablePrSurface,
} from "./helpers/executorDurableHarness.js";

const mocks = vi.hoisted(() => ({
  runDurableWorkItem: vi.fn(),
  getAppBotIdentity: vi.fn(),
  withPrRepositoryView: vi.fn(),
  runVerification: vi.fn(),
  publishVerification: vi.fn(),
  loadRepoPolicy: vi.fn(),
  listTriageEligibleInlineReviews: vi.fn(),
  shouldSkipWork: vi.fn(),
  recordPublishStep: vi.fn(),
}));

vi.mock("../src/agentWork/durableJob.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agentWork/durableJob.js")>();
  return { ...actual, runDurableWorkItem: mocks.runDurableWorkItem };
});

vi.mock("../src/github/appAuth.js", () => ({
  getAppBotIdentity: mocks.getAppBotIdentity,
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

vi.mock("../src/review/repoPolicy.js", () => ({
  loadRepoPolicy: mocks.loadRepoPolicy,
}));

vi.mock("../src/agentWork/repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agentWork/repository.js")>();
  return {
    ...actual,
    listTriageEligibleInlineReviews: mocks.listTriageEligibleInlineReviews,
    shouldSkipWork: mocks.shouldSkipWork,
  };
});

import type { BotFindingThread } from "../src/review/run/reviewPriorFeedback.js";
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
      prSurface: fakeDurablePrSurface(),
      headSha: "a".repeat(40),
      leaseEpoch: 1,
      signal: new AbortController().signal,
    }),
  );
}

function findingThread(
  rootCommentId: number,
  overrides: Partial<{
    path: string;
    line: number;
    severity: BotFindingThread["severity"];
    titleSnippet: string;
    humanReplies: string[];
    hasTriageReply: boolean;
  }> = {},
): BotFindingThread {
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

function configureVerificationThreads(
  entries: ReadonlyArray<readonly [number, { threadNodeId: string; isResolved: boolean }]>,
) {
  durablePrSurfaceControls().setThreads(new Map(entries));
}

function configureDefaultPrFiles() {
  durablePrSurfaceControls().setChangedFilesResult({
    files: [{ filename: "src/app.ts", status: "modified", additions: 1, deletions: 1, changes: 2 }],
    truncated: false,
    omittedCountLowerBound: 0,
    totalChanges: 10,
    headSha: "a".repeat(40),
  });
  durablePrSurfaceControls().setPushedCommits([
    { sha: "b".repeat(40), subject: "fix: guard user" },
  ]);
}

describe("executeVerificationJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDurablePrSurface({ headSha: "a".repeat(40) });
    mockDurableExecution();
    configureDefaultPrFiles();
    configureVerificationThreads([[1, { threadNodeId: "node", isResolved: false }]]);
    mocks.getAppBotIdentity.mockResolvedValue({ userId: 999, login: "pr-agent[bot]" });
    durablePrSurfaceControls().setBotFindingThreads([]);
    mocks.withPrRepositoryView.mockImplementation(
      async (_params: unknown, run: (view: unknown) => Promise<unknown>) =>
        run({ agentCwd: "/tmp/view", workspace: {}, preflight: {} }),
    );
    mocks.runVerification.mockResolvedValue({
      submitted: true,
      payload: { verdicts: [] },
    });
    mocks.publishVerification.mockResolvedValue({ degraded: false });
    mocks.loadRepoPolicy.mockResolvedValue({ kind: "absent" });
    mocks.listTriageEligibleInlineReviews.mockResolvedValue(new Map());
    mocks.shouldSkipWork.mockResolvedValue(false);
  });

  it("short-circuits quietly when there are no open findings", async () => {
    durablePrSurfaceControls().setBotFindingThreads([]);

    await executeVerificationJob(cfg, pool, boss, job());

    expect(mocks.withPrRepositoryView).not.toHaveBeenCalled();
    expect(mocks.runVerification).not.toHaveBeenCalled();
    expect(mocks.publishVerification).not.toHaveBeenCalled();
  });

  it("short-circuits when all findings are already resolved", async () => {
    durablePrSurfaceControls().setBotFindingThreads([findingThread(1, { path: "src/app.ts" })]);
    configureVerificationThreads([[1, { threadNodeId: "node", isResolved: true }]]);

    await executeVerificationJob(cfg, pool, boss, job());

    expect(mocks.withPrRepositoryView).not.toHaveBeenCalled();
    expect(mocks.runVerification).not.toHaveBeenCalled();
    expect(mocks.publishVerification).not.toHaveBeenCalled();
  });

  it("runs the verification agent and publishes when there are open findings", async () => {
    durablePrSurfaceControls().setBotFindingThreads([findingThread(1, { path: "src/app.ts" })]);
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
    expect(mocks.loadRepoPolicy).toHaveBeenCalledWith("/tmp/view", expect.any(Number));
    expect(mocks.publishVerification).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          verdicts: expect.arrayContaining([expect.objectContaining({ verdict: "fixed" })]),
        }),
        changedFilePaths: [],
        policyResult: { kind: "absent" },
      }),
    );
    expect(
      durablePrSurfaceControls().events.some((event) => event.kind === "listCommitCompareFiles"),
    ).toBe(false);
  });

  it("gates skipped-reply paths on the push-delta compare when pushBeforeSha is present", async () => {
    const beforeSha = "c".repeat(40);
    mockDurableExecution(
      item({
        payload: { repositorySizeKb: 100, pushBeforeSha: beforeSha },
      }),
    );
    durablePrSurfaceControls().setBotFindingThreads([
      findingThread(1, { path: "src/app.ts" }),
      findingThread(2, { path: "src/other.ts" }),
    ]);
    configureVerificationThreads([
      [1, { threadNodeId: "node-1", isResolved: false }],
      [2, { threadNodeId: "node-2", isResolved: false }],
    ]);
    durablePrSurfaceControls().setChangedFilesResult({
      files: [
        { filename: "src/app.ts", status: "modified", additions: 1, deletions: 0, changes: 1 },
        { filename: "README.md", status: "modified", additions: 1, deletions: 0, changes: 1 },
      ],
      truncated: false,
      omittedCountLowerBound: 0,
      totalChanges: 20,
      headSha: "a".repeat(40),
    });
    durablePrSurfaceControls().setCommitCompareFilesResult({
      files: ["src/delta.ts", "src/app.ts"],
      truncated: false,
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

    expect(
      durablePrSurfaceControls().events.some(
        (event) =>
          event.kind === "listCommitCompareFiles" &&
          event.base === beforeSha &&
          event.head === "a".repeat(40),
      ),
    ).toBe(true);
    expect(mocks.publishVerification).toHaveBeenCalledWith(
      expect.objectContaining({
        changedFilePaths: ["src/delta.ts", "src/app.ts"],
      }),
    );
  });

  it("uses an empty changedFilePaths set when pushBeforeSha is absent", async () => {
    durablePrSurfaceControls().setBotFindingThreads([
      findingThread(1, { path: "src/app.ts" }),
      findingThread(2, { path: "src/other.ts" }),
    ]);
    configureVerificationThreads([
      [1, { threadNodeId: "node-1", isResolved: false }],
      [2, { threadNodeId: "node-2", isResolved: false }],
    ]);
    durablePrSurfaceControls().setChangedFilesResult({
      files: [
        { filename: "src/app.ts", status: "modified", additions: 1, deletions: 0, changes: 1 },
        { filename: "README.md", status: "modified", additions: 1, deletions: 0, changes: 1 },
      ],
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

    expect(
      durablePrSurfaceControls().events.some((event) => event.kind === "listCommitCompareFiles"),
    ).toBe(false);
    expect(mocks.publishVerification).toHaveBeenCalledWith(
      expect.objectContaining({
        changedFilePaths: [],
      }),
    );
  });

  it("throws when the agent does not submit a payload", async () => {
    durablePrSurfaceControls().setBotFindingThreads([findingThread(1, { path: "src/app.ts" })]);
    mocks.runVerification.mockResolvedValue({
      submitted: false,
      payload: null,
    });

    await expect(executeVerificationJob(cfg, pool, boss, job())).rejects.toThrow(
      "Verification run ended without submitVerification",
    );
    expect(mocks.publishVerification).not.toHaveBeenCalled();
  });

  it("does not publish when head SHA is stale at publish time", async () => {
    durablePrSurfaceControls().setBotFindingThreads([findingThread(1, { path: "src/app.ts" })]);
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
    durablePrSurfaceControls().setHeadSha("f".repeat(40));

    await executeVerificationJob(cfg, pool, boss, job());

    expect(mocks.runVerification).toHaveBeenCalled();
    expect(durablePrSurfaceControls().events.some((event) => event.kind === "getHeadSha")).toBe(
      true,
    );
    expect(mocks.publishVerification).not.toHaveBeenCalled();
  });

  it("does not publish when cancel was requested before publish", async () => {
    durablePrSurfaceControls().setBotFindingThreads([findingThread(1, { path: "src/app.ts" })]);
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
    mocks.shouldSkipWork.mockResolvedValue(true);

    await executeVerificationJob(cfg, pool, boss, job());

    expect(mocks.runVerification).toHaveBeenCalled();
    expect(mocks.publishVerification).not.toHaveBeenCalled();
  });

  it("propagates degraded when publishVerification reports degraded", async () => {
    durablePrSurfaceControls().setBotFindingThreads([findingThread(1, { path: "src/app.ts" })]);
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
        prSurface: fakeDurablePrSurface(),
        headSha: "a".repeat(40),
        leaseEpoch: 1,
        signal: new AbortController().signal,
      });
    });

    await executeVerificationJob(cfg, pool, boss, job());

    expect(executeResult).toEqual({ degraded: true });
  });

  it("continues findings evaluation when reviewThreads GraphQL is permission_denied", async () => {
    durablePrSurfaceControls().setBotFindingThreads([findingThread(1, { path: "src/app.ts" })]);
    durablePrSurfaceControls().setThreadResolutionStatus(
      "permission_denied",
      "grant Pull requests read for reviewThreads",
    );
    mocks.runVerification.mockResolvedValue({
      submitted: true,
      payload: {
        verdicts: [
          {
            verdict: "skipped",
            threadRootCommentId: 1,
            reason: "still open",
          },
        ],
      },
    });

    let executeResult: unknown;
    mocks.runDurableWorkItem.mockImplementation(async (spec: DurableJobSpec<"verification">) => {
      executeResult = await spec.execute(item(), {
        prSurface: fakeDurablePrSurface(),
        headSha: "a".repeat(40),
        leaseEpoch: 1,
        signal: new AbortController().signal,
      });
    });

    await executeVerificationJob(cfg, pool, boss, job());

    expect(mocks.runVerification).toHaveBeenCalled();
    expect(mocks.publishVerification).toHaveBeenCalled();
    expect(executeResult).toEqual({ degraded: true });
  });

  it.each([
    {
      label: "299 files",
      files: Array.from({ length: 299 }, (_, i) => `src/f${i}.ts`),
      truncated: false,
    },
    {
      label: "300 files",
      files: Array.from({ length: 300 }, (_, i) => `src/f${i}.ts`),
      truncated: true,
    },
    {
      label: "more than 300 files signaled",
      files: Array.from({ length: 300 }, (_, i) => `src/f${i}.ts`),
      truncated: true,
    },
  ] as const)("propagates compare truncation for $label pushes", async ({ files, truncated }) => {
    const beforeSha = "c".repeat(40);
    mockDurableExecution(
      item({
        payload: { repositorySizeKb: 100, pushBeforeSha: beforeSha },
      }),
    );
    durablePrSurfaceControls().setBotFindingThreads([findingThread(1, { path: "src/app.ts" })]);
    durablePrSurfaceControls().setChangedFilesResult({
      files: [
        { filename: "src/app.ts", status: "modified", additions: 1, deletions: 0, changes: 1 },
        { filename: "README.md", status: "modified", additions: 1, deletions: 0, changes: 1 },
      ],
      truncated: false,
      omittedCountLowerBound: 0,
      totalChanges: 20,
      headSha: "a".repeat(40),
    });
    durablePrSurfaceControls().setCommitCompareFilesResult({ files: [...files], truncated });
    mocks.runVerification.mockResolvedValue({
      submitted: true,
      payload: {
        verdicts: [
          {
            verdict: "skipped",
            threadRootCommentId: 1,
            reason: "still open",
          },
        ],
      },
    });

    let executeResult: unknown;
    mocks.runDurableWorkItem.mockImplementation(async (spec: DurableJobSpec<"verification">) => {
      executeResult = await spec.execute(
        item({
          payload: { repositorySizeKb: 100, pushBeforeSha: beforeSha },
        }),
        {
          prSurface: fakeDurablePrSurface(),
          headSha: "a".repeat(40),
          leaseEpoch: 1,
          signal: new AbortController().signal,
        },
      );
    });

    await executeVerificationJob(cfg, pool, boss, job());

    expect(mocks.runVerification).toHaveBeenCalledWith(
      expect.objectContaining({ compareFilesTruncated: truncated }),
    );
    expect(mocks.publishVerification).toHaveBeenCalledWith(
      expect.objectContaining({
        changedFilePathsTruncated: truncated,
        ...(truncated
          ? {
              changedFilePaths: expect.arrayContaining(["src/app.ts", "README.md"]),
            }
          : { changedFilePaths: files }),
      }),
    );
    if (truncated) {
      expect(executeResult).toEqual({ degraded: true });
    }
  });
});
