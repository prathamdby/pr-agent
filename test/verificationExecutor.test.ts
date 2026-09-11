import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { DurableJobSpec } from "../src/agentWork/durableJob.js";
import type { VerificationJobData } from "../src/agentWork/types.js";
import * as evlog from "../src/evlog.js";
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
  publishVerificationFailure: vi.fn(),
  clearVerificationFailureSignal: vi.fn(),
  loadRepoPolicy: vi.fn(),
  listTriageEligibleInlineReviews: vi.fn(),
  shouldSkipWork: vi.fn(),
  recordPublishStep: vi.fn(),
  captureEvent: vi.fn(),
}));

vi.mock("../src/analytics/index.js", () => ({
  captureEvent: (...args: unknown[]) => mocks.captureEvent(...args),
  captureException: vi.fn(),
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

vi.mock("../src/agent/verification/publishVerificationFailure.js", () => ({
  publishVerificationFailure: mocks.publishVerificationFailure,
  clearVerificationFailureSignal: mocks.clearVerificationFailureSignal,
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
import {
  STALE_VERIFICATION_RESULT,
  verificationHeadFreshness,
} from "../src/agentWork/verificationPublishGate.js";
import { makeVerificationWorkItem } from "./helpers/agentWorkItems.js";

const cfg = makeTestConfig();
const pool = {} as Pool;
const boss = {} as PgBoss;
const verificationWorkspace = { agentCwd: "/tmp/view" };

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

describe("verificationHeadFreshness", () => {
  it("is fresh when bound and live heads match", () => {
    expect(verificationHeadFreshness("a".repeat(40), "a".repeat(40))).toEqual({ kind: "fresh" });
  });

  it("is stale and keeps both SHAs when heads differ", () => {
    expect(verificationHeadFreshness("a".repeat(40), "f".repeat(40))).toEqual({
      kind: "stale",
      boundHeadSha: "a".repeat(40),
      latestHeadSha: "f".repeat(40),
    });
  });

  it("uses completed with stale_head as the stale terminal", () => {
    expect(STALE_VERIFICATION_RESULT).toEqual({ kind: "completed", degradation: ["stale_head"] });
  });
});

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
        run({
          agentCwd: verificationWorkspace.agentCwd,
          workspace: verificationWorkspace,
          preflight: {},
        }),
    );
    mocks.runVerification.mockResolvedValue({
      submitted: true,
      payload: { verdicts: [] },
    });
    mocks.publishVerification.mockResolvedValue({ degradation: [] });
    mocks.publishVerificationFailure.mockResolvedValue({
      headSha: "a".repeat(40),
      commentId: 1,
      surface: "ci_cell",
    });
    mocks.clearVerificationFailureSignal.mockResolvedValue(undefined);
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
    expect(mocks.publishVerificationFailure).not.toHaveBeenCalled();
    expect(mocks.clearVerificationFailureSignal).toHaveBeenCalledTimes(1);
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
        workspace: verificationWorkspace,
        inventory: [expect.objectContaining({ rootCommentId: 1 })],
        pushedCommits: expect.arrayContaining([expect.objectContaining({ sha: "b".repeat(40) })]),
      }),
    );
    expect(mocks.runVerification.mock.calls[0]?.[0]).not.toHaveProperty("rootDir");
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

  it.each([
    {
      label: "fresh head × slash",
      source: "slash" as const,
      liveHeadSha: "a".repeat(40),
      expected: { kind: "completed" },
      publishes: true,
    },
    {
      label: "fresh head × auto",
      source: "auto" as const,
      liveHeadSha: "a".repeat(40),
      expected: { kind: "completed" },
      publishes: true,
    },
    {
      label: "stale head × slash",
      source: "slash" as const,
      liveHeadSha: "f".repeat(40),
      expected: STALE_VERIFICATION_RESULT,
      publishes: false,
    },
    {
      label: "stale head × auto",
      source: "auto" as const,
      liveHeadSha: "f".repeat(40),
      expected: STALE_VERIFICATION_RESULT,
      publishes: false,
    },
  ] as const)(
    "maps $label publish-gate outcome",
    async ({ source, liveHeadSha, expected, publishes }) => {
      const boundHeadSha = "a".repeat(40);
      const workItem = item({ source });
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
      durablePrSurfaceControls().setHeadSha(liveHeadSha);
      const infoSpy = vi.spyOn(evlog, "logInfo");

      let executeResult: unknown;
      mocks.runDurableWorkItem.mockImplementation(async (spec: DurableJobSpec<"verification">) => {
        executeResult = await spec.execute(workItem, {
          prSurface: fakeDurablePrSurface(),
          headSha: boundHeadSha,
          leaseEpoch: 1,
          signal: new AbortController().signal,
        });
      });

      await executeVerificationJob(cfg, pool, boss, job());

      expect(executeResult).toEqual(expected);
      expect(mocks.publishVerification).toHaveBeenCalledTimes(publishes ? 1 : 0);
      if (!publishes) {
        expect(infoSpy).toHaveBeenCalledWith(
          "verification_publish_skipped",
          expect.objectContaining({
            reason: "stale_head",
            boundHeadSha,
            latestHeadSha: liveHeadSha,
          }),
        );
      }
      infoSpy.mockRestore();
    },
  );

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

  it("returns publish degradation reasons and emits no failure event", async () => {
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
    mocks.publishVerification.mockResolvedValue({
      degradation: ["verdict_mapping_incomplete"],
    });
    const warnSpy = vi.spyOn(evlog, "logWarn");

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

    expect(executeResult).toEqual({
      kind: "completed",
      degradation: ["verdict_mapping_incomplete"],
    });
    expect(warnSpy).toHaveBeenCalledWith(
      "verification_publish_degraded",
      expect.objectContaining({
        resolutionStatus: "ok",
        degradation: ["verdict_mapping_incomplete"],
      }),
    );
    expect(mocks.captureEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "work completed",
        properties: expect.objectContaining({
          work_type: "verification",
          outcome: "degraded",
          degraded_reason: "durable_degradation",
        }),
      }),
    );
    warnSpy.mockRestore();
  });

  it("orders the inventory oldest-first and binds one value to prompt and publish", async () => {
    durablePrSurfaceControls().setBotFindingThreads([
      findingThread(3),
      findingThread(1),
      findingThread(2),
    ]);
    configureVerificationThreads([
      [3, { threadNodeId: "node-3", isResolved: false }],
      [1, { threadNodeId: "node-1", isResolved: false }],
      [2, { threadNodeId: "node-2", isResolved: false }],
    ]);
    mocks.runVerification.mockResolvedValue({ submitted: true, payload: { verdicts: [] } });

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

    const runParams = mocks.runVerification.mock.calls[0]?.[0] as {
      inventory: readonly BotFindingThread[];
      escalation?: unknown;
    };
    const publishParams = mocks.publishVerification.mock.calls[0]?.[0] as {
      inventory: readonly BotFindingThread[];
    };
    expect(runParams.inventory.map((thread) => thread.rootCommentId)).toEqual([1, 2, 3]);
    expect(publishParams.inventory).toBe(runParams.inventory);
    expect(runParams.escalation).toBeUndefined();
    expect(executeResult).toEqual({ kind: "completed" });
    expect(mocks.captureEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "work completed",
        properties: expect.objectContaining({
          work_type: "verification",
          outcome: "published",
        }),
      }),
    );
  });

  it("narrows the escalated attempt inventory once and reports inventory_narrowed", async () => {
    const ids = [12, 3, 8, 1, 10, 5, 2, 11, 7, 4, 9, 6];
    durablePrSurfaceControls().setBotFindingThreads(ids.map((id) => findingThread(id)));
    configureVerificationThreads(
      ids.map((id) => [id, { threadNodeId: `node-${id}`, isResolved: false }] as const),
    );
    mocks.runVerification.mockResolvedValue({ submitted: true, payload: { verdicts: [] } });
    const escalation = { attempt: 2, kinds: ["tool_rounds"] as const };

    let executeResult: unknown;
    mocks.runDurableWorkItem.mockImplementation(async (spec: DurableJobSpec<"verification">) => {
      executeResult = await spec.execute(item(), {
        prSurface: fakeDurablePrSurface(),
        headSha: "a".repeat(40),
        leaseEpoch: 1,
        signal: new AbortController().signal,
        escalation,
      });
    });

    await executeVerificationJob(cfg, pool, boss, job());

    const runParams = mocks.runVerification.mock.calls[0]?.[0] as {
      inventory: readonly BotFindingThread[];
      escalation?: unknown;
    };
    const publishParams = mocks.publishVerification.mock.calls[0]?.[0] as {
      inventory: readonly BotFindingThread[];
    };
    expect(runParams.inventory.map((thread) => thread.rootCommentId)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(publishParams.inventory).toBe(runParams.inventory);
    expect(runParams.escalation).toBe(escalation);
    expect(executeResult).toEqual({ kind: "completed", degradation: ["inventory_narrowed"] });
    expect(mocks.captureEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "work completed",
        properties: expect.objectContaining({
          work_type: "verification",
          outcome: "degraded",
          degraded_reason: "durable_degradation",
        }),
      }),
    );
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
    expect(executeResult).toEqual({
      kind: "completed",
      degradation: ["thread_resolution_degraded"],
    });
    expect(mocks.captureEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "work completed",
        properties: expect.objectContaining({
          work_type: "verification",
          outcome: "degraded",
          degraded_reason: "durable_degradation",
        }),
      }),
    );
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
    expect(executeResult).toEqual(
      truncated
        ? { kind: "completed", degradation: ["compare_files_truncated"] }
        : { kind: "completed" },
    );
    expect(mocks.captureEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "work completed",
        properties: expect.objectContaining({
          work_type: "verification",
          outcome: truncated ? "degraded" : "published",
          ...(truncated ? { degraded_reason: "durable_degradation" } : {}),
        }),
      }),
    );
  });

  it("does not publish a failure signal on a successful run", async () => {
    durablePrSurfaceControls().setBotFindingThreads([findingThread(1, { path: "src/app.ts" })]);

    await executeVerificationJob(cfg, pool, boss, job());

    expect(mocks.publishVerification).toHaveBeenCalled();
    expect(mocks.publishVerificationFailure).not.toHaveBeenCalled();
    expect(mocks.clearVerificationFailureSignal).toHaveBeenCalledTimes(1);
  });

  it("publishes one failure signal from the terminal failure hook", async () => {
    let hooked = false;
    mocks.runDurableWorkItem.mockImplementation(async (spec: DurableJobSpec<"verification">) => {
      await spec.onTerminalFailure?.(
        item(),
        fakeDurablePrSurface(),
        new Error("provider timeout"),
        1,
      );
      hooked = true;
    });

    await executeVerificationJob(cfg, pool, boss, job());

    expect(hooked).toBe(true);
    expect(mocks.publishVerificationFailure).toHaveBeenCalledTimes(1);
    expect(mocks.publishVerificationFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        workItemId: "wi-1",
        resourceKey: expect.any(String),
        headSha: "a".repeat(40),
        leaseEpoch: 1,
      }),
    );
    expect(mocks.publishVerification).not.toHaveBeenCalled();
  });
});
