import { createDurableExecutionContext } from "../src/agentWork/durableJob.ts";
import { makeDurableJobMetadata } from "./helpers/executorDurableHarness.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { mockWorkClaim } from "./helpers/executorDurableHarness.ts";
import type { PgBoss } from "pg-boss";
import * as evlog from "../src/evlog.ts";
import { makeTestConfig } from "./helpers/config.ts";
import {
  durablePrSurfaceControls,
  fakeDurablePrSurface,
  resetDurablePrSurface,
  seedBotFindingThreads,
} from "./helpers/executorDurableHarness.ts";

const mocks = vi.hoisted(() => ({
  getAppBotIdentity: vi.fn(),
  withPrRepositoryView: vi.fn(),
  runVerification: vi.fn(),
  publishVerification: vi.fn(),
  publishVerificationFailure: vi.fn(),
  clearVerificationFailureSignal: vi.fn(),
  loadRepoPolicy: vi.fn(),
  listTriageEligibleInlineReviews: vi.fn(),
  shouldSkipWork: vi.fn(),
}));

vi.mock("../src/github/appAuth.ts", () => ({
  getAppBotIdentity: mocks.getAppBotIdentity,
}));

vi.mock("../src/prWorkspace/prRepositoryView.ts", () => ({
  withPrRepositoryView: mocks.withPrRepositoryView,
}));

vi.mock("../src/agent/verification/verificationRun.ts", () => ({
  runVerification: mocks.runVerification,
}));

vi.mock("../src/agent/verification/publishVerification.ts", () => ({
  publishVerification: mocks.publishVerification,
}));

vi.mock("../src/agent/verification/publishVerificationFailure.ts", () => ({
  publishVerificationFailure: mocks.publishVerificationFailure,
  clearVerificationFailureSignal: mocks.clearVerificationFailureSignal,
}));

vi.mock("../src/review/repoPolicy.ts", () => ({
  loadRepoPolicy: mocks.loadRepoPolicy,
}));

vi.mock("../src/agentWork/prActorLease.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agentWork/prActorLease.ts")>();
  return { ...actual, isPrActorLeaseHeld: vi.fn().mockResolvedValue(true) };
});

vi.mock("../src/agentWork/publishRecordRepository.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/agentWork/publishRecordRepository.ts")>()),
  listTriageEligibleInlineReviews: mocks.listTriageEligibleInlineReviews,
}));

vi.mock("../src/agentWork/workItemStateRepository.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/agentWork/workItemStateRepository.ts")>()),
  shouldSkipWork: mocks.shouldSkipWork,
}));

vi.mock("../src/agentWork/verificationThreadLedger.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/agentWork/verificationThreadLedger.ts")>();
  return {
    ...actual,
    loadVerificationThreadLedger: vi.fn(async () => ({ threads: {} })),
  };
});

import type { BotFindingThread } from "../src/review/run/reviewPriorFeedback.ts";
import { createWorkDefinitions } from "../src/agentWork/workDefinition.ts";
import { openInstallationSurface } from "../src/agentWork/installationSurface.ts";
import {
  STALE_VERIFICATION_RESULT,
  verificationHeadFreshness,
} from "../src/agentWork/verificationPublishGate.ts";
import { makeVerificationWorkItem } from "./helpers/agentWorkItems.ts";

let runExecution: () => Promise<unknown>;
function configureExecution(
  run: (definition: ReturnType<typeof createWorkDefinitions>["verification"]) => Promise<unknown>,
): void {
  runExecution = () =>
    run(
      createWorkDefinitions({ cfg, pool, boss, installationSurface: openInstallationSurface() })
        .verification,
    );
}

const cfg = makeTestConfig();
const pool = {} as Pool;
const boss = {} as PgBoss;
const verificationWorkspace = {
  agentCwd: "/tmp/view",
  policySnapshot: { kind: "unavailable" as const, reason: "missing_base_sha" as const },
};

function item(overrides: Parameters<typeof makeVerificationWorkItem>[0] = {}) {
  return makeVerificationWorkItem({
    headSha: "a".repeat(40),
    payload: { repositorySizeKb: 100 },
    ...overrides,
  });
}

function mockDurableExecution(workItem = item()): void {
  configureExecution(async (spec) =>
    spec.execute(
      workItem,
      createDurableExecutionContext({
        pool,
        item: workItem,
        prSurface: fakeDurablePrSurface(),
        headSha: "a".repeat(40),
        leaseEpoch: 1,
        job: makeDurableJobMetadata(),
        beginAttempt: async () => mockWorkClaim(),
        signal: new AbortController().signal,
        getClaim: () => undefined,
        getEscalation: () => undefined,
      }),
    ),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function callArgument(fn: {
  mock: { calls: readonly (readonly unknown[])[] };
}): Record<string, unknown> {
  const value = fn.mock.calls[0]?.[0];
  if (!isRecord(value)) throw new Error("expected an object argument");
  return value;
}

function inventoryThreads(argument: Record<string, unknown>): readonly Record<string, unknown>[] {
  if (!Array.isArray(argument.inventory)) throw new Error("expected an inventory");
  return argument.inventory.map((thread) => {
    if (!isRecord(thread)) throw new Error("expected a thread");
    return thread;
  });
}

function objectionCommentIds(thread: Record<string, unknown> | undefined): number[] | undefined {
  if (thread == null || thread.objections == null) return undefined;
  if (!Array.isArray(thread.objections)) throw new Error("expected objections");
  return thread.objections.map((objection) => {
    if (!isRecord(objection) || typeof objection.commentId !== "number") {
      throw new Error("expected an objection");
    }
    return objection.commentId;
  });
}

function rootCommentIds(threads: readonly Record<string, unknown>[]): number[] {
  return threads.map((thread) => {
    if (typeof thread.rootCommentId !== "number") throw new Error("expected a root comment id");
    return thread.rootCommentId;
  });
}

async function addUserObjections(
  rootCommentId: number,
  replies: readonly { readonly id: number; readonly createdAt: string }[],
): Promise<void> {
  const listed = await fakeDurablePrSurface().listReviewComments();
  const rootAt = "2026-01-01T13:00:00Z";
  durablePrSurfaceControls().setReviewComments([
    ...listed.comments.map((comment) =>
      comment.id === rootCommentId
        ? { ...comment, authorType: "Bot", createdAt: rootAt, updatedAt: rootAt }
        : comment,
    ),
    ...replies.map((reply) => ({
      id: reply.id,
      inReplyToId: rootCommentId,
      pullRequestReviewId: null,
      userId: 7,
      authorLogin: "alice",
      authorAssociation: "NONE",
      authorType: "User",
      createdAt: reply.createdAt,
      updatedAt: reply.createdAt,
      body: `Objection ${reply.id}`,
      path: null,
      line: null,
      originalLine: null,
      htmlUrl: "",
    })),
  ]);
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
    expect(STALE_VERIFICATION_RESULT).toMatchObject({
      kind: "completed",
      degradation: ["stale_head"],
    });
  });
});

describe("verification work definition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDurablePrSurface({ headSha: "a".repeat(40) });
    mockDurableExecution();
    configureDefaultPrFiles();
    configureVerificationThreads([[1, { threadNodeId: "node", isResolved: false }]]);
    mocks.getAppBotIdentity.mockResolvedValue({ userId: 999, login: "pr-agent[bot]" });
    seedBotFindingThreads([]);
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
    seedBotFindingThreads([]);

    await runExecution();

    expect(mocks.withPrRepositoryView).not.toHaveBeenCalled();
    expect(mocks.runVerification).not.toHaveBeenCalled();
    expect(mocks.publishVerification).not.toHaveBeenCalled();
    expect(mocks.publishVerificationFailure).not.toHaveBeenCalled();
    expect(mocks.clearVerificationFailureSignal).toHaveBeenCalledTimes(1);
  });

  it("short-circuits when all findings are already resolved", async () => {
    seedBotFindingThreads([findingThread(1, { path: "src/app.ts" })]);
    configureVerificationThreads([[1, { threadNodeId: "node", isResolved: true }]]);

    await runExecution();

    expect(mocks.withPrRepositoryView).not.toHaveBeenCalled();
    expect(mocks.runVerification).not.toHaveBeenCalled();
    expect(mocks.publishVerification).not.toHaveBeenCalled();
  });

  it("runs the verification agent and publishes when there are open findings", async () => {
    seedBotFindingThreads([findingThread(1, { path: "src/app.ts" })]);
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

    await runExecution();

    expect(mocks.withPrRepositoryView).toHaveBeenCalled();
    expect(mocks.runVerification).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: verificationWorkspace,
        inventory: [expect.objectContaining({ rootCommentId: 1 })],
        pushedCommits: expect.arrayContaining([expect.objectContaining({ sha: "b".repeat(40) })]),
      }),
    );
    expect(mocks.runVerification.mock.calls[0]?.[0]).not.toHaveProperty("rootDir");
    expect(mocks.loadRepoPolicy).not.toHaveBeenCalled();
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

  it("passes an ok base snapshot through to verification publish", async () => {
    const baseSha = "c".repeat(40);
    durablePrSurfaceControls().setPullRequest({
      title: "",
      body: null,
      additions: 0,
      deletions: 0,
      changed_files: 0,
      state: "open",
      merged: false,
      merged_at: null,
      head: { sha: "a".repeat(40), ref: "branch", repo: { full_name: "o/r" } },
      base: { sha: baseSha, repo: { full_name: "fork/o/r" } },
    });
    const policy = {
      kind: "ok" as const,
      policy: {
        rules: [
          {
            filename: "src.mdc",
            relativePath: ".pr-agent/src.mdc",
            alwaysApply: false,
            globs: ["src/**"],
            body: "existing",
          },
        ],
      },
    };
    mocks.loadRepoPolicy.mockResolvedValue(policy);
    mocks.withPrRepositoryView.mockImplementation(
      async (params: unknown, run: (view: unknown) => Promise<unknown>) => {
        expect(params).toMatchObject({ baseSha });
        return run({
          agentCwd: verificationWorkspace.agentCwd,
          workspace: {
            ...verificationWorkspace,
            policySnapshot: {
              kind: "ok",
              baseSha,
              files: [{ path: ".pr-agent/src.mdc", blobSha: "d".repeat(40), body: "existing\n" }],
              drops: [],
            },
          },
          preflight: {},
        });
      },
    );
    seedBotFindingThreads([findingThread(1, { path: "src/app.ts" })]);

    await runExecution();

    expect(mocks.loadRepoPolicy).toHaveBeenCalledWith(
      [{ path: ".pr-agent/src.mdc", body: "existing\n" }],
      expect.any(Number),
    );
    expect(mocks.publishVerification).toHaveBeenCalledWith(
      expect.objectContaining({ policyResult: policy }),
    );
  });

  it("publishes a starter path when the base sha is missing and keeps the prior degradation set", async () => {
    const warn = vi.spyOn(evlog, "logWarn").mockImplementation(() => undefined);
    seedBotFindingThreads([findingThread(1, { path: "src/app.ts" })]);
    mocks.publishVerification.mockResolvedValue({ degradation: ["compare_files_truncated"] });

    await expect(runExecution()).resolves.toMatchObject({
      kind: "completed",
      degradation: ["compare_files_truncated"],
    });

    expect(mocks.withPrRepositoryView.mock.calls[0]?.[0]).not.toHaveProperty("baseSha");
    expect(mocks.loadRepoPolicy).not.toHaveBeenCalled();
    expect(mocks.publishVerification).toHaveBeenCalledWith(
      expect.objectContaining({ policyResult: { kind: "absent" } }),
    );
    expect(warn).toHaveBeenCalledWith(
      "verification_repo_policy_unavailable",
      expect.objectContaining({ reason: "missing_base_sha" }),
    );
  });

  it("fails the run when the freshness head read throws", async () => {
    seedBotFindingThreads([findingThread(1, { path: "src/app.ts" })]);
    vi.spyOn(fakeDurablePrSurface(), "getHead").mockRejectedValueOnce(
      new Error("head unavailable"),
    );

    await expect(runExecution()).rejects.toThrow("head unavailable");

    expect(mocks.withPrRepositoryView).not.toHaveBeenCalled();
    expect(mocks.publishVerification).not.toHaveBeenCalled();
  });

  it("gates skipped-reply paths on the push-delta compare when pushBeforeSha is present", async () => {
    const beforeSha = "c".repeat(40);
    mockDurableExecution(
      item({
        payload: { repositorySizeKb: 100, pushBeforeSha: beforeSha },
      }),
    );
    seedBotFindingThreads([
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

    await runExecution();

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
    seedBotFindingThreads([
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

    await runExecution();

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
    seedBotFindingThreads([findingThread(1, { path: "src/app.ts" })]);
    mocks.runVerification.mockResolvedValue({
      submitted: false,
      payload: null,
    });

    await expect(runExecution()).rejects.toThrow(
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
      seedBotFindingThreads([findingThread(1, { path: "src/app.ts" })]);
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
      configureExecution(async (spec) => {
        executeResult = await spec.execute(
          workItem,
          createDurableExecutionContext({
            pool,
            item: workItem,
            prSurface: fakeDurablePrSurface(),
            headSha: boundHeadSha,
            leaseEpoch: 1,
            job: makeDurableJobMetadata(),
            beginAttempt: async () => mockWorkClaim(),
            signal: new AbortController().signal,
            getClaim: () => undefined,
            getEscalation: () => undefined,
          }),
        );
      });

      await runExecution();

      expect(executeResult).toMatchObject(expected);
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
    seedBotFindingThreads([findingThread(1, { path: "src/app.ts" })]);
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

    await runExecution();

    expect(mocks.runVerification).toHaveBeenCalled();
    expect(mocks.publishVerification).not.toHaveBeenCalled();
  });

  it("returns publish degradation reasons and emits no failure event", async () => {
    seedBotFindingThreads([findingThread(1, { path: "src/app.ts" })]);
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
    configureExecution(async (spec) => {
      executeResult = await spec.execute(
        item(),
        createDurableExecutionContext({
          pool,
          item: item(),
          prSurface: fakeDurablePrSurface(),
          headSha: "a".repeat(40),
          leaseEpoch: 1,
          job: makeDurableJobMetadata(),
          beginAttempt: async () => mockWorkClaim(),
          signal: new AbortController().signal,
          getClaim: () => undefined,
          getEscalation: () => undefined,
        }),
      );
    });

    await runExecution();

    expect(executeResult).toMatchObject({
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
    warnSpy.mockRestore();
  });

  it("orders the inventory oldest-first and binds one value to prompt and publish", async () => {
    seedBotFindingThreads([findingThread(3), findingThread(1), findingThread(2)]);
    configureVerificationThreads([
      [3, { threadNodeId: "node-3", isResolved: false }],
      [1, { threadNodeId: "node-1", isResolved: false }],
      [2, { threadNodeId: "node-2", isResolved: false }],
    ]);
    mocks.runVerification.mockResolvedValue({ submitted: true, payload: { verdicts: [] } });

    let executeResult: unknown;
    configureExecution(async (spec) => {
      executeResult = await spec.execute(
        item(),
        createDurableExecutionContext({
          pool,
          item: item(),
          prSurface: fakeDurablePrSurface(),
          headSha: "a".repeat(40),
          leaseEpoch: 1,
          job: makeDurableJobMetadata(),
          beginAttempt: async () => mockWorkClaim(),
          signal: new AbortController().signal,
          getClaim: () => undefined,
          getEscalation: () => undefined,
        }),
      );
    });

    await runExecution();

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
    expect(executeResult).toMatchObject({ kind: "completed" });
  });

  it("narrows the escalated attempt inventory once and reports inventory_narrowed", async () => {
    const ids = [12, 3, 8, 1, 10, 5, 2, 11, 7, 4, 9, 6];
    seedBotFindingThreads(ids.map((id) => findingThread(id)));
    configureVerificationThreads(
      ids.map((id) => [id, { threadNodeId: `node-${id}`, isResolved: false }] as const),
    );
    mocks.runVerification.mockResolvedValue({ submitted: true, payload: { verdicts: [] } });
    const escalation = { attempt: 2, kinds: ["tool_rounds"] as const };

    let executeResult: unknown;
    configureExecution(async (spec) => {
      executeResult = await spec.execute(
        item(),
        createDurableExecutionContext({
          pool,
          item: item(),
          prSurface: fakeDurablePrSurface(),
          headSha: "a".repeat(40),
          leaseEpoch: 1,
          job: makeDurableJobMetadata(),
          beginAttempt: async () => mockWorkClaim(),
          signal: new AbortController().signal,
          getEscalation: () => escalation,
          getClaim: () => undefined,
        }),
      );
    });

    await runExecution();

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
    expect(executeResult).toMatchObject({ kind: "completed", degradation: ["inventory_narrowed"] });
  });

  it("presents an objection on the prompt inventory and the publish call", async () => {
    seedBotFindingThreads([findingThread(1)]);
    configureVerificationThreads([[1, { threadNodeId: "node-1", isResolved: false }]]);
    await addUserObjections(1, [{ id: 50, createdAt: "2026-01-01T14:32:47Z" }]);
    mocks.runVerification.mockResolvedValue({
      submitted: true,
      payload: { verdicts: [{ verdict: "skipped", threadRootCommentId: 1, reason: "open" }] },
    });

    await runExecution();

    const runArg = callArgument(mocks.runVerification);
    const publishArg = callArgument(mocks.publishVerification);
    expect(objectionCommentIds(inventoryThreads(runArg)[0])).toEqual([50]);
    expect(publishArg.inventory).toBe(runArg.inventory);
  });

  it("publishes verdicts without answers when the review comment list is truncated", async () => {
    seedBotFindingThreads([findingThread(1)]);
    configureVerificationThreads([[1, { threadNodeId: "node-1", isResolved: false }]]);
    await addUserObjections(1, [{ id: 50, createdAt: "2026-01-01T14:32:47Z" }]);
    durablePrSurfaceControls().setReviewCommentsTruncated(true);
    mocks.runVerification.mockResolvedValue({
      submitted: true,
      payload: { verdicts: [{ verdict: "skipped", threadRootCommentId: 1, reason: "open" }] },
    });

    let executeResult: unknown;
    configureExecution(async (spec) => {
      executeResult = await spec.execute(
        item(),
        createDurableExecutionContext({
          pool,
          item: item(),
          prSurface: fakeDurablePrSurface(),
          headSha: "a".repeat(40),
          leaseEpoch: 1,
          job: makeDurableJobMetadata(),
          beginAttempt: async () => mockWorkClaim(),
          signal: new AbortController().signal,
          getClaim: () => undefined,
          getEscalation: () => undefined,
        }),
      );
    });
    await runExecution();

    const publishThreads = inventoryThreads(callArgument(mocks.publishVerification));
    expect(mocks.publishVerification).toHaveBeenCalled();
    expect(publishThreads[0]?.objections).toBeUndefined();
    expect(executeResult).toMatchObject({
      degradation: ["objection_detection_incomplete"],
    });
  });

  it("presents the eight oldest objections and reports the cap", async () => {
    seedBotFindingThreads([findingThread(1)]);
    configureVerificationThreads([[1, { threadNodeId: "node-1", isResolved: false }]]);
    await addUserObjections(
      1,
      [50, 51, 52, 53, 54, 55, 56, 57, 58].map((id, index) => ({
        id,
        createdAt: `2026-01-01T14:${String(index).padStart(2, "0")}:00Z`,
      })),
    );
    mocks.runVerification.mockResolvedValue({
      submitted: true,
      payload: { verdicts: [{ verdict: "skipped", threadRootCommentId: 1, reason: "open" }] },
    });

    let executeResult: unknown;
    configureExecution(async (spec) => {
      executeResult = await spec.execute(
        item(),
        createDurableExecutionContext({
          pool,
          item: item(),
          prSurface: fakeDurablePrSurface(),
          headSha: "a".repeat(40),
          leaseEpoch: 1,
          job: makeDurableJobMetadata(),
          beginAttempt: async () => mockWorkClaim(),
          signal: new AbortController().signal,
          getClaim: () => undefined,
          getEscalation: () => undefined,
        }),
      );
    });
    await runExecution();

    expect(objectionCommentIds(inventoryThreads(callArgument(mocks.runVerification))[0])).toEqual([
      50, 51, 52, 53, 54, 55, 56, 57,
    ]);
    expect(executeResult).toMatchObject({
      degradation: ["objection_answers_capped"],
      completion: { objectionsPresented: 8, objectionsDeferredByCap: 1 },
    });
  });

  it("drops an objection with its thread when the escalated inventory narrows", async () => {
    const ids = [12, 3, 8, 1, 10, 5, 2, 11, 7, 4, 9, 6];
    seedBotFindingThreads(ids.map((id) => findingThread(id)));
    configureVerificationThreads(
      ids.map((id) => [id, { threadNodeId: `node-${id}`, isResolved: false }] as const),
    );
    await addUserObjections(12, [{ id: 90, createdAt: "2026-01-01T14:32:47Z" }]);
    mocks.runVerification.mockResolvedValue({ submitted: true, payload: { verdicts: [] } });
    const escalation = { attempt: 2, kinds: ["tool_rounds"] as const };

    let executeResult: unknown;
    configureExecution(async (spec) => {
      executeResult = await spec.execute(
        item(),
        createDurableExecutionContext({
          pool,
          item: item(),
          prSurface: fakeDurablePrSurface(),
          headSha: "a".repeat(40),
          leaseEpoch: 1,
          job: makeDurableJobMetadata(),
          beginAttempt: async () => mockWorkClaim(),
          signal: new AbortController().signal,
          getClaim: () => undefined,
          getEscalation: () => escalation,
        }),
      );
    });
    await runExecution();

    const threads = inventoryThreads(callArgument(mocks.runVerification));
    expect(rootCommentIds(threads)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(threads.some((thread) => thread.objections != null)).toBe(false);
    expect(executeResult).toMatchObject({ degradation: ["inventory_narrowed"] });
    expect(executeResult).not.toMatchObject({
      degradation: expect.arrayContaining(["objection_answers_capped"]),
    });
  });

  it("continues findings evaluation when reviewThreads GraphQL is permission_denied", async () => {
    seedBotFindingThreads([findingThread(1, { path: "src/app.ts" })]);
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
    configureExecution(async (spec) => {
      executeResult = await spec.execute(
        item(),
        createDurableExecutionContext({
          pool,
          item: item(),
          prSurface: fakeDurablePrSurface(),
          headSha: "a".repeat(40),
          leaseEpoch: 1,
          job: makeDurableJobMetadata(),
          beginAttempt: async () => mockWorkClaim(),
          signal: new AbortController().signal,
          getClaim: () => undefined,
          getEscalation: () => undefined,
        }),
      );
    });

    await runExecution();

    expect(mocks.runVerification).toHaveBeenCalled();
    expect(mocks.publishVerification).toHaveBeenCalled();
    expect(executeResult).toMatchObject({
      kind: "completed",
      degradation: ["thread_resolution_degraded"],
    });
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
    seedBotFindingThreads([findingThread(1, { path: "src/app.ts" })]);
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
    configureExecution(async (spec) => {
      executeResult = await spec.execute(
        item({
          payload: { repositorySizeKb: 100, pushBeforeSha: beforeSha },
        }),
        createDurableExecutionContext({
          pool,
          item: item({
            payload: { repositorySizeKb: 100, pushBeforeSha: beforeSha },
          }),
          prSurface: fakeDurablePrSurface(),
          headSha: "a".repeat(40),
          leaseEpoch: 1,
          job: makeDurableJobMetadata(),
          beginAttempt: async () => mockWorkClaim(),
          signal: new AbortController().signal,
          getClaim: () => undefined,
          getEscalation: () => undefined,
        }),
      );
    });

    await runExecution();

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
    expect(executeResult).toMatchObject(
      truncated
        ? { kind: "completed", degradation: ["compare_files_truncated"] }
        : { kind: "completed" },
    );
  });

  it("does not publish a failure signal on a successful run", async () => {
    seedBotFindingThreads([findingThread(1, { path: "src/app.ts" })]);

    await runExecution();

    expect(mocks.publishVerification).toHaveBeenCalled();
    expect(mocks.publishVerificationFailure).not.toHaveBeenCalled();
    expect(mocks.clearVerificationFailureSignal).toHaveBeenCalledTimes(1);
  });

  it("publishes one failure signal from the terminal failure hook", async () => {
    let hooked = false;
    configureExecution(async (spec) => {
      await spec.onTerminalFailure?.(
        item(),
        fakeDurablePrSurface(),
        new Error("provider timeout"),
        1,
      );
      hooked = true;
    });

    await runExecution();

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
