import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { PgBoss } from "pg-boss";
import type { JobWithMetadata } from "pg-boss";
import type {
  VerificationJobData,
  VerificationWorkItem,
  VerificationWorkPayload,
} from "../src/agentWork/types.js";
import { makeTestConfig } from "./helpers/config.js";
import {
  durablePrSurfaceControls,
  fakeDurablePrSurface,
  makeDurableJobMetadata,
  resetDurablePrSurface,
} from "./helpers/executorDurableHarness.js";
import { resetCreatePrSurface, setCreatePrSurface } from "../src/github/prSurface.js";
import type { BotFindingThread } from "../src/review/run/reviewPriorFeedback.js";
import { executeVerificationJob } from "../src/agentWork/executors/verificationExecutor.js";
import { makeVerificationWorkItem } from "./helpers/agentWorkItems.js";
import * as durableJob from "../src/agentWork/durableJob.js";
import * as appAuth from "../src/github/appAuth.js";
import * as prWorkspace from "../src/prWorkspace/index.js";
import * as verificationRun from "../src/agent/verification/verificationRun.js";
import type { VerificationRunResult } from "../src/agent/verification/verificationRun.js";
import * as publishVerification from "../src/agent/verification/publishVerification.js";
import * as repoPolicy from "../src/review/repoPolicy.js";
import * as repo from "../src/agentWork/repository.js";
import type { PrRepositoryView } from "../src/prWorkspace/prRepositoryView.js";
import { mockLocalPrWorkspace } from "./helpers/mockWorkspace.js";
import { assistantFromText } from "../src/agentRun/sessionHelpers.js";

const cfg = makeTestConfig();
const pool = new Pool({ connectionString: "postgres://127.0.0.1:1/unused" });
const boss = new PgBoss({ connectionString: "postgres://127.0.0.1:1/unused" });

type VerificationExecuteResult = {
  readonly degraded?: boolean;
};

type VerificationItemOverrides = Omit<
  Partial<VerificationWorkItem>,
  "type" | "payload" | "reviewLens" | "source"
> & {
  payload?: Partial<VerificationWorkPayload>;
};

type FindingThreadOverrides = {
  readonly path?: string;
  readonly line?: number;
  readonly severity?: BotFindingThread["severity"];
  readonly titleSnippet?: string;
  readonly humanReplies?: string[];
  readonly hasTriageReply?: boolean;
};

const emptyPreflight = {
  files: [] as const,
  truncated: false,
  fileCount: 0,
  totalChanges: 0,
};

function repositoryView(): PrRepositoryView {
  return {
    agentCwd: "/tmp/view",
    workspace: mockLocalPrWorkspace("/tmp/view"),
    preflight: emptyPreflight,
  };
}

function verificationResult(overrides: Partial<VerificationRunResult> = {}): VerificationRunResult {
  return {
    submitted: true,
    payload: { verdicts: [] },
    lastAssistant: assistantFromText(cfg, "", cfg.piProvider),
    ...overrides,
  };
}

function item(overrides: VerificationItemOverrides = {}) {
  return makeVerificationWorkItem({
    headSha: "a".repeat(40),
    payload: { repositorySizeKb: 100 },
    ...overrides,
  });
}

function job(): JobWithMetadata<VerificationJobData> {
  return {
    ...makeDurableJobMetadata("wi-1"),
    name: "agent-work-verification",
    data: { kind: "verification", workItemId: "wi-1" },
  };
}

function mockDurableExecution(workItem = item()): void {
  vi.mocked(durableJob.runDurableWorkItem).mockImplementation(async (spec) => {
    if (spec.type !== "verification") return;
    await spec.execute(workItem, {
      prSurface: fakeDurablePrSurface(),
      headSha: "a".repeat(40),
      executionEpoch: 1,
      signal: new AbortController().signal,
    });
  });
}

function findingThread(
  rootCommentId: number,
  overrides: FindingThreadOverrides = {},
): BotFindingThread {
  return {
    rootCommentId,
    lens: "review",
    path: "src/app.ts",
    line: 1,
    severity: "P1",
    titleSnippet: "P1 · Bug",
    humanReplies: [],
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
    resetDurablePrSurface({ headSha: "a".repeat(40) });
    setCreatePrSurface(() => fakeDurablePrSurface());
    vi.spyOn(durableJob, "runDurableWorkItem");
    mockDurableExecution();
    configureDefaultPrFiles();
    configureVerificationThreads([[1, { threadNodeId: "node", isResolved: false }]]);
    vi.spyOn(appAuth, "getAppBotIdentity").mockResolvedValue({
      userId: 999,
      login: "pr-agent[bot]",
    });
    durablePrSurfaceControls().setBotFindingThreads([]);
    vi.spyOn(prWorkspace, "withPrRepositoryView").mockImplementation(async (_params, run) =>
      run(repositoryView()),
    );
    vi.spyOn(verificationRun, "runVerification").mockResolvedValue(verificationResult());
    vi.spyOn(publishVerification, "publishVerification").mockResolvedValue({ degraded: false });
    vi.spyOn(repoPolicy, "loadRepoPolicy").mockResolvedValue({ kind: "absent" });
    vi.spyOn(repo, "listTriageEligibleInlineReviews").mockResolvedValue(new Map());
    vi.spyOn(repo, "shouldSkipWork").mockResolvedValue(false);
  });

  afterEach(() => {
    resetCreatePrSurface();
    vi.restoreAllMocks();
  });

  it("short-circuits quietly when there are no open findings", async () => {
    durablePrSurfaceControls().setBotFindingThreads([]);

    await executeVerificationJob(cfg, pool, boss, job());

    expect(vi.mocked(prWorkspace.withPrRepositoryView)).not.toHaveBeenCalled();
    expect(vi.mocked(verificationRun.runVerification)).not.toHaveBeenCalled();
    expect(vi.mocked(publishVerification.publishVerification)).not.toHaveBeenCalled();
  });

  it("short-circuits when all findings are already resolved", async () => {
    durablePrSurfaceControls().setBotFindingThreads([findingThread(1, { path: "src/app.ts" })]);
    configureVerificationThreads([[1, { threadNodeId: "node", isResolved: true }]]);

    await executeVerificationJob(cfg, pool, boss, job());

    expect(vi.mocked(prWorkspace.withPrRepositoryView)).not.toHaveBeenCalled();
    expect(vi.mocked(verificationRun.runVerification)).not.toHaveBeenCalled();
    expect(vi.mocked(publishVerification.publishVerification)).not.toHaveBeenCalled();
  });

  it("runs the verification agent and publishes when there are open findings", async () => {
    durablePrSurfaceControls().setBotFindingThreads([findingThread(1, { path: "src/app.ts" })]);
    vi.mocked(verificationRun.runVerification).mockResolvedValue(
      verificationResult({
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
      }),
    );

    await executeVerificationJob(cfg, pool, boss, job());

    expect(vi.mocked(prWorkspace.withPrRepositoryView)).toHaveBeenCalled();
    expect(vi.mocked(verificationRun.runVerification)).toHaveBeenCalledWith(
      expect.objectContaining({
        inventory: [expect.objectContaining({ rootCommentId: 1 })],
        pushedCommits: expect.arrayContaining([expect.objectContaining({ sha: "b".repeat(40) })]),
      }),
    );
    expect(vi.mocked(repoPolicy.loadRepoPolicy)).toHaveBeenCalledWith(
      "/tmp/view",
      expect.any(Number),
    );
    expect(vi.mocked(publishVerification.publishVerification)).toHaveBeenCalledWith(
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
    vi.mocked(verificationRun.runVerification).mockResolvedValue(
      verificationResult({
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
      }),
    );

    await executeVerificationJob(cfg, pool, boss, job());

    expect(
      durablePrSurfaceControls().events.some(
        (event) =>
          event.kind === "listCommitCompareFiles" &&
          event.base === beforeSha &&
          event.head === "a".repeat(40),
      ),
    ).toBe(true);
    expect(vi.mocked(publishVerification.publishVerification)).toHaveBeenCalledWith(
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
    vi.mocked(verificationRun.runVerification).mockResolvedValue(
      verificationResult({
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
      }),
    );

    await executeVerificationJob(cfg, pool, boss, job());

    expect(
      durablePrSurfaceControls().events.some((event) => event.kind === "listCommitCompareFiles"),
    ).toBe(false);
    expect(vi.mocked(publishVerification.publishVerification)).toHaveBeenCalledWith(
      expect.objectContaining({
        changedFilePaths: [],
      }),
    );
  });

  it("throws when the agent does not submit a payload", async () => {
    durablePrSurfaceControls().setBotFindingThreads([findingThread(1, { path: "src/app.ts" })]);
    vi.mocked(verificationRun.runVerification).mockResolvedValue(
      verificationResult({
        submitted: false,
        payload: null,
      }),
    );

    await expect(executeVerificationJob(cfg, pool, boss, job())).rejects.toThrow(
      "Verification run ended without submitVerification",
    );
    expect(vi.mocked(publishVerification.publishVerification)).not.toHaveBeenCalled();
  });

  it("does not publish when head SHA is stale at publish time", async () => {
    durablePrSurfaceControls().setBotFindingThreads([findingThread(1, { path: "src/app.ts" })]);
    vi.mocked(verificationRun.runVerification).mockResolvedValue(
      verificationResult({
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
      }),
    );
    durablePrSurfaceControls().setHeadSha("f".repeat(40));

    await executeVerificationJob(cfg, pool, boss, job());

    expect(vi.mocked(verificationRun.runVerification)).toHaveBeenCalled();
    expect(durablePrSurfaceControls().events.some((event) => event.kind === "getHeadSha")).toBe(
      true,
    );
    expect(vi.mocked(publishVerification.publishVerification)).not.toHaveBeenCalled();
  });

  it("does not publish when cancel was requested before publish", async () => {
    durablePrSurfaceControls().setBotFindingThreads([findingThread(1, { path: "src/app.ts" })]);
    vi.mocked(verificationRun.runVerification).mockResolvedValue(
      verificationResult({
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
      }),
    );
    vi.mocked(repo.shouldSkipWork).mockResolvedValue(true);

    await executeVerificationJob(cfg, pool, boss, job());

    expect(vi.mocked(verificationRun.runVerification)).toHaveBeenCalled();
    expect(vi.mocked(publishVerification.publishVerification)).not.toHaveBeenCalled();
  });

  it("propagates degraded when publishVerification reports degraded", async () => {
    durablePrSurfaceControls().setBotFindingThreads([findingThread(1, { path: "src/app.ts" })]);
    vi.mocked(verificationRun.runVerification).mockResolvedValue(
      verificationResult({
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
      }),
    );
    vi.mocked(publishVerification.publishVerification).mockResolvedValue({ degraded: true });

    let executeResult: VerificationExecuteResult | undefined;
    vi.mocked(durableJob.runDurableWorkItem).mockImplementation(async (spec) => {
      if (spec.type !== "verification") return;
      executeResult = await spec.execute(item(), {
        prSurface: fakeDurablePrSurface(),
        headSha: "a".repeat(40),
        executionEpoch: 1,
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
    vi.mocked(verificationRun.runVerification).mockResolvedValue(
      verificationResult({
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
      }),
    );

    let executeResult: VerificationExecuteResult | undefined;
    vi.mocked(durableJob.runDurableWorkItem).mockImplementation(async (spec) => {
      if (spec.type !== "verification") return;
      executeResult = await spec.execute(item(), {
        prSurface: fakeDurablePrSurface(),
        headSha: "a".repeat(40),
        executionEpoch: 1,
        signal: new AbortController().signal,
      });
    });

    await executeVerificationJob(cfg, pool, boss, job());

    expect(vi.mocked(verificationRun.runVerification)).toHaveBeenCalled();
    expect(vi.mocked(publishVerification.publishVerification)).toHaveBeenCalled();
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
    vi.mocked(verificationRun.runVerification).mockResolvedValue(
      verificationResult({
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
      }),
    );

    let executeResult: VerificationExecuteResult | undefined;
    vi.mocked(durableJob.runDurableWorkItem).mockImplementation(async (spec) => {
      if (spec.type !== "verification") return;
      executeResult = await spec.execute(
        item({
          payload: { repositorySizeKb: 100, pushBeforeSha: beforeSha },
        }),
        {
          prSurface: fakeDurablePrSurface(),
          headSha: "a".repeat(40),
          executionEpoch: 1,
          signal: new AbortController().signal,
        },
      );
    });

    await executeVerificationJob(cfg, pool, boss, job());

    expect(vi.mocked(verificationRun.runVerification)).toHaveBeenCalledWith(
      expect.objectContaining({ compareFilesTruncated: truncated }),
    );
    if (truncated) {
      expect(vi.mocked(publishVerification.publishVerification)).toHaveBeenCalledWith(
        expect.objectContaining({
          changedFilePathsTruncated: true,
          changedFilePaths: expect.arrayContaining(["src/app.ts", "README.md"]),
        }),
      );
    } else {
      expect(vi.mocked(publishVerification.publishVerification)).toHaveBeenCalledWith(
        expect.objectContaining({
          changedFilePathsTruncated: false,
          changedFilePaths: files,
        }),
      );
    }
    if (truncated) {
      expect(executeResult).toEqual({ degraded: true });
    }
  });
});
