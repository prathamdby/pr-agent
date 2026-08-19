import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Pool } from "pg";
import type { Config } from "../src/config.js";
import {
  clearDurableAuthCachesForTest,
  mintInstallationToken,
  runDurableWorkItem,
  type DurableExecutionResult,
  type DurableJobSpec,
} from "../src/agentWork/durableJob.js";
import type { AgentWorkItem } from "../src/agentWork/types.js";
import { makeAskWorkItem, makeReviewWorkItem } from "./helpers/agentWorkItems.js";
import { coreOf } from "./helpers/executorDurableHarness.js";

vi.mock("../src/agentWork/repository.js", () => ({
  getWorkItem: vi.fn(),
  getWorkItemCore: vi.fn(),
  getWorkItemPayload: vi.fn(),
  shouldSkipWork: vi.fn(),
  markWorkCancelled: vi.fn(),
  markQueuedWorkCancelled: vi.fn(),
  claimWorkForExecution: vi.fn(),
  markWorkCompleted: vi.fn(),
  forceMarkRescheduledParentCompleted: vi.fn(),
  markWorkFailed: vi.fn(),
  markWorkPublishDegraded: vi.fn(),
  markWorkRetrying: vi.fn(),
  updateRunningWorkHeadSha: vi.fn(),
}));

vi.mock("../src/agentWork/prActorLease.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agentWork/prActorLease.js")>();
  return {
    ...actual,
    acquirePrActorLease: vi.fn(),
    isPrActorLeaseHeld: vi.fn(),
    releasePrActorLease: vi.fn(),
    renewPrActorLease: vi.fn(),
  };
});

vi.mock("../src/agentWork/reviewReschedule.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agentWork/reviewReschedule.js")>();
  return {
    ...actual,
    cancelOrphanedStaleHeadReplacementOnTerminalFailure: vi.fn(),
  };
});

vi.mock("../src/github/appAuth.js", () => ({
  mintInstallationAuth: vi.fn(),
  getAppBotIdentity: vi.fn(),
}));

const prSurfaceMocks = vi.hoisted(() => ({
  setAcknowledgementReaction: vi.fn().mockResolvedValue(undefined),
  getHead: vi.fn(async () => ({ headSha: "x", pullRequest: {} })),
}));

vi.mock("../src/github/prSurface.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/github/prSurface.js")>();
  return {
    ...actual,
    createPrSurface: vi.fn(() => ({
      owner: "o",
      repo: "r",
      prNumber: 1,
      getHead: prSurfaceMocks.getHead,
      setAcknowledgementReaction: prSurfaceMocks.setAcknowledgementReaction,
    })),
  };
});

vi.mock("../src/evlog.js", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import * as repo from "../src/agentWork/repository.js";
import * as prActorLease from "../src/agentWork/prActorLease.js";
import * as reviewReschedule from "../src/agentWork/reviewReschedule.js";
import * as appAuth from "../src/github/appAuth.js";
import * as evlog from "../src/evlog.js";
import { GITHUB_REACTION_MINUS_ONE, GITHUB_REACTION_PLUS_ONE } from "../src/settings/index.js";

const cfg = {
  prActorLeaseTtlSeconds: 900,
  prActorLeaseRenewalIntervalSeconds: 120,
} as Config;
const pool = {} as Pool;
const boss = {
  send: vi.fn().mockResolvedValue("deferred-job"),
  findJobs: vi.fn().mockResolvedValue([]),
} as unknown as PgBoss;

function makeItem(
  overrides: Parameters<typeof makeReviewWorkItem>[0] & { status?: AgentWorkItem["status"] } = {},
): AgentWorkItem {
  return makeReviewWorkItem({ status: "queued", ...overrides });
}

function mockFetchedItem(item: AgentWorkItem | null): void {
  vi.mocked(repo.getWorkItem).mockResolvedValue(item);
  vi.mocked(repo.getWorkItemCore).mockResolvedValue(item ? coreOf(item) : null);
  vi.mocked(repo.getWorkItemPayload).mockResolvedValue(item?.payload);
}

function mockFetchedItems(...items: AgentWorkItem[]): void {
  vi.mocked(repo.getWorkItem).mockReset();
  vi.mocked(repo.getWorkItemCore).mockReset();
  vi.mocked(repo.getWorkItemPayload).mockReset();
  for (const item of items) {
    vi.mocked(repo.getWorkItem).mockResolvedValueOnce(item);
    vi.mocked(repo.getWorkItemCore).mockResolvedValueOnce(coreOf(item));
    vi.mocked(repo.getWorkItemPayload).mockResolvedValueOnce(item.payload);
  }
}

function makeJob(retryCount = 0, retryLimit = 3): JobWithMetadata<{ workItemId: string }> {
  return {
    id: "job-1",
    data: { workItemId: "wi-1" },
    retryCount,
    retryLimit,
    signal: new AbortController().signal,
  } as unknown as JobWithMetadata<{ workItemId: string }>;
}

function completedResult(degraded?: boolean): DurableExecutionResult {
  return degraded ? { kind: "completed", degraded: true } : { kind: "completed" };
}

function rescheduledResult(
  overrides: Partial<Omit<Extract<DurableExecutionResult, { kind: "rescheduled" }>, "kind">> = {},
): Extract<DurableExecutionResult, { kind: "rescheduled" }> {
  return {
    kind: "rescheduled",
    replacementWorkItemId: "replacement-wi",
    afterComplete: vi.fn().mockResolvedValue(undefined),
    onRescheduleAbort: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function runReviewWorkItem(
  overrides: Partial<DurableJobSpec<"review">> & Pick<DurableJobSpec<"review">, "execute">,
): Promise<void> {
  return runDurableWorkItem({
    cfg,
    pool,
    boss,
    job: makeJob(),
    type: "review",
    prActorLease: { queue: "agent-work-review" },
    resolveHeadSha: async () => ({ headSha: "x" }),
    ...overrides,
  });
}

function defaultMocks() {
  vi.mocked(repo.getWorkItem).mockReset();
  vi.mocked(repo.getWorkItemCore).mockReset();
  vi.mocked(repo.getWorkItemPayload).mockReset();
  vi.mocked(repo.shouldSkipWork).mockResolvedValue(false);
  vi.mocked(repo.claimWorkForExecution).mockResolvedValue(true);
  vi.mocked(prActorLease.acquirePrActorLease).mockResolvedValue({
    acquired: true,
    leaseEpoch: 1,
  });
  vi.mocked(prActorLease.isPrActorLeaseHeld).mockResolvedValue(true);
  vi.mocked(prActorLease.releasePrActorLease).mockResolvedValue(undefined);
  vi.mocked(prActorLease.renewPrActorLease).mockResolvedValue(true);
  vi.mocked(boss.send).mockClear();
  vi.mocked(boss.findJobs).mockReset();
  vi.mocked(boss.findJobs).mockResolvedValue([]);
  vi.mocked(repo.updateRunningWorkHeadSha).mockResolvedValue(true);
  vi.mocked(repo.markWorkCompleted).mockResolvedValue(true);
  vi.mocked(repo.markWorkFailed).mockResolvedValue(true);
  vi.mocked(repo.markWorkRetrying).mockResolvedValue(true);
  vi.mocked(repo.markWorkCancelled).mockResolvedValue();
  vi.mocked(repo.markQueuedWorkCancelled).mockResolvedValue(true);
  vi.mocked(repo.markWorkPublishDegraded).mockResolvedValue();
  vi.mocked(appAuth.mintInstallationAuth).mockResolvedValue({
    type: "token",
    tokenType: "installation",
    token: "tok",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    installationId: 42,
  } as Awaited<ReturnType<typeof appAuth.mintInstallationAuth>>);
  clearDurableAuthCachesForTest();
  vi.mocked(appAuth.getAppBotIdentity).mockResolvedValue({
    userId: 999,
    login: "pr-agent[bot]",
  } as Awaited<ReturnType<typeof appAuth.getAppBotIdentity>>);
}

describe("runDurableWorkItem", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    defaultMocks();
  });

  it("happy path: claims, mints token, resolves head, executes, marks completed", async () => {
    const item = makeItem();
    mockFetchedItem(item);
    const execute = vi.fn().mockResolvedValue(completedResult());

    await runReviewWorkItem({ resolveHeadSha: async () => ({ headSha: "abc123" }), execute });

    expect(repo.claimWorkForExecution).toHaveBeenCalledWith(pool, "wi-1");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1].headSha).toBe("abc123");
    expect(execute.mock.calls[0]?.[1].prSurface).toBeDefined();
    expect(repo.markWorkCompleted).toHaveBeenCalledWith(pool, "wi-1", 1);
    expect(repo.markWorkCancelled).not.toHaveBeenCalled();
    expect(repo.shouldSkipWork).toHaveBeenCalledTimes(2);
    expect(repo.markWorkPublishDegraded).not.toHaveBeenCalled();
  });

  it("claims through the unified path and acquires the PR actor lease", async () => {
    const item = makeItem();
    mockFetchedItem(item);
    const execute = vi.fn().mockResolvedValue(completedResult());

    await runReviewWorkItem({ resolveHeadSha: async () => ({ headSha: "abc123" }), execute });

    expect(repo.getWorkItemCore).toHaveBeenCalledWith(pool, "wi-1");
    expect(repo.claimWorkForExecution).toHaveBeenCalledWith(pool, "wi-1");
    expect(prActorLease.acquirePrActorLease).toHaveBeenCalledWith(pool, {
      resourceKey: item.resourceKey,
      workType: "review",
      workItemId: "wi-1",
      holderId: expect.stringContaining(String(process.pid)),
      ttlSeconds: 900,
    });
    const acquireOrder = vi.mocked(prActorLease.acquirePrActorLease).mock.invocationCallOrder[0];
    const claimOrder = vi.mocked(repo.claimWorkForExecution).mock.invocationCallOrder[0];
    expect(acquireOrder).toBeDefined();
    expect(claimOrder).toBeDefined();
    expect(acquireOrder).toBeLessThan(claimOrder ?? 0);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1].leaseEpoch).toBe(1);
    expect(prActorLease.releasePrActorLease).toHaveBeenCalledWith(pool, {
      resourceKey: item.resourceKey,
      workType: "review",
      leaseEpoch: 1,
    });
  });

  it("defers a redelivery without claiming when another work item holds the lease", async () => {
    const item = makeItem();
    mockFetchedItem(item);
    vi.mocked(prActorLease.acquirePrActorLease).mockResolvedValue({
      acquired: false,
      heldByWorkItemId: "wi-other",
      leaseEpoch: 7,
    });
    const execute = vi.fn();

    await runReviewWorkItem({ execute });

    expect(execute).not.toHaveBeenCalled();
    expect(repo.claimWorkForExecution).not.toHaveBeenCalled();
    expect(boss.send).toHaveBeenCalledWith(
      "agent-work-review",
      { workItemId: "wi-1" },
      expect.objectContaining({
        singletonKey: "wi-1",
        singletonSeconds: prActorLease.PR_ACTOR_LEASE_DEFER_SECONDS,
        singletonNextSlot: true,
        startAfter: prActorLease.PR_ACTOR_LEASE_DEFER_SECONDS,
        group: { id: expect.any(String) },
      }),
    );
    expect(repo.markWorkCompleted).not.toHaveBeenCalled();
    expect(repo.markWorkFailed).not.toHaveBeenCalled();
    expect(prActorLease.releasePrActorLease).not.toHaveBeenCalled();
  });

  it("defers a redelivery when its own lease is still held, so a crashed execution is retried", async () => {
    const item = makeItem();
    mockFetchedItem(item);
    vi.mocked(prActorLease.acquirePrActorLease).mockResolvedValue({
      acquired: false,
      heldByWorkItemId: "wi-1",
      leaseEpoch: 7,
    });
    const execute = vi.fn();

    await runReviewWorkItem({ execute });

    expect(execute).not.toHaveBeenCalled();
    expect(repo.claimWorkForExecution).not.toHaveBeenCalled();
    expect(boss.send).toHaveBeenCalledWith(
      "agent-work-review",
      { workItemId: "wi-1" },
      expect.objectContaining({
        singletonKey: "wi-1",
        singletonSeconds: prActorLease.PR_ACTOR_LEASE_DEFER_SECONDS,
        singletonNextSlot: true,
      }),
    );
    expect(prActorLease.releasePrActorLease).not.toHaveBeenCalled();
  });

  it("returns when a lease deferral send is swallowed but a queued hop already exists", async () => {
    const item = makeItem();
    mockFetchedItem(item);
    vi.mocked(prActorLease.acquirePrActorLease).mockResolvedValue({
      acquired: false,
      heldByWorkItemId: "wi-other",
      leaseEpoch: 7,
    });
    vi.mocked(boss.send).mockResolvedValue(null);
    vi.mocked(boss.findJobs).mockResolvedValue([{ id: "hop-1", state: "created" }] as never);

    await runReviewWorkItem({ execute: vi.fn() });

    expect(boss.findJobs).toHaveBeenCalledWith(
      "agent-work-review",
      expect.objectContaining({ key: "wi-1", queued: true }),
    );
    expect(repo.claimWorkForExecution).not.toHaveBeenCalled();
    expect(repo.markWorkFailed).not.toHaveBeenCalled();
  });

  it("throws when a lease deferral send is swallowed and no queued hop remains", async () => {
    const item = makeItem();
    mockFetchedItem(item);
    vi.mocked(prActorLease.acquirePrActorLease).mockResolvedValue({
      acquired: false,
      heldByWorkItemId: "wi-other",
      leaseEpoch: 7,
    });
    vi.mocked(boss.send).mockResolvedValue(null);
    const execute = vi.fn();

    await expect(runReviewWorkItem({ execute })).rejects.toMatchObject({
      code: "agent_work.lease_watchdog_arm_failed",
    });
    expect(execute).not.toHaveBeenCalled();
    expect(repo.claimWorkForExecution).not.toHaveBeenCalled();
    expect(repo.markWorkFailed).not.toHaveBeenCalled();
  });

  it("releases the lease on the retry path so the next attempt re-acquires", async () => {
    const item = makeItem();
    mockFetchedItem(item);
    const boom = new Error("transient");
    const execute = vi.fn().mockRejectedValue(boom);

    await expect(runReviewWorkItem({ job: makeJob(0, 3), execute })).rejects.toBe(boom);

    expect(prActorLease.releasePrActorLease).toHaveBeenCalledWith(pool, {
      resourceKey: item.resourceKey,
      workType: "review",
      leaseEpoch: 1,
    });
  });

  it("stops at the next checkpoint without terminalising when the lease is lost mid-run", async () => {
    const item = makeItem();
    mockFetchedItem(item);
    vi.mocked(prActorLease.isPrActorLeaseHeld).mockResolvedValue(false);
    const execute = vi.fn().mockResolvedValue(completedResult());

    await runReviewWorkItem({ execute });

    expect(execute).not.toHaveBeenCalled();
    expect(repo.markWorkCompleted).not.toHaveBeenCalled();
    expect(repo.markWorkFailed).not.toHaveBeenCalled();
    expect(repo.markWorkCancelled).not.toHaveBeenCalled();
    expect(evlog.logInfo).toHaveBeenCalledWith(
      "agent_work_stale_execution_skipped",
      expect.objectContaining({ workItemId: "wi-1", leaseEpoch: 1 }),
    );
  });

  it("gates on acceptItem when provided", async () => {
    const item = makeItem();
    mockFetchedItem(item);
    const execute = vi.fn().mockResolvedValue(completedResult());

    await runReviewWorkItem({
      acceptItem: (it) => it.reviewLens != null,
      execute,
    });

    expect(repo.claimWorkForExecution).toHaveBeenCalledWith(pool, "wi-1");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("terminalizes running work when payload is malformed after claim", async () => {
    const item = makeItem();
    vi.mocked(repo.getWorkItemCore).mockResolvedValue(coreOf(item));
    vi.mocked(repo.getWorkItemPayload).mockResolvedValue({ question: "not-a-review-payload" });
    vi.mocked(repo.markWorkFailed).mockResolvedValue(true);
    const execute = vi.fn();

    await expect(
      runReviewWorkItem({
        acceptItem: (it) => it.reviewLens != null,
        execute,
      }),
    ).rejects.toThrow(/Invalid review work item payload/);

    expect(repo.claimWorkForExecution).toHaveBeenCalledWith(pool, "wi-1");
    expect(repo.markWorkFailed).toHaveBeenCalledWith(
      pool,
      "wi-1",
      expect.objectContaining({ name: "WorkItemPayloadValidationError" }),
      1,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("passes resolved pull payload into execution context", async () => {
    const item = makeItem();
    mockFetchedItem(item);
    const pullRequest = {
      additions: 1,
      deletions: 0,
      changed_files: 1,
      head: { sha: "abc123" },
    };
    const execute = vi.fn().mockResolvedValue(completedResult());

    await runReviewWorkItem({
      resolveHeadSha: async () => ({ headSha: "abc123", pullRequest }),
      execute,
    });

    expect(repo.updateRunningWorkHeadSha).toHaveBeenCalledWith(pool, "wi-1", "abc123", 1);
    expect(execute.mock.calls[0]?.[1].pullRequest).toBe(pullRequest);
  });

  it("returns without executing when payload row is missing after claim", async () => {
    const item = makeItem();
    vi.mocked(repo.getWorkItemCore).mockResolvedValue(coreOf(item));
    vi.mocked(repo.getWorkItemPayload).mockResolvedValue(undefined);
    const execute = vi.fn();

    await runReviewWorkItem({ execute });

    expect(repo.claimWorkForExecution).toHaveBeenCalledWith(pool, "wi-1");
    expect(execute).not.toHaveBeenCalled();
    expect(repo.markWorkCompleted).not.toHaveBeenCalled();
    expect(repo.markWorkFailed).not.toHaveBeenCalled();
  });

  it("terminalizes running work when payload is JSON null after claim", async () => {
    const item = makeItem();
    vi.mocked(repo.getWorkItemCore).mockResolvedValue(coreOf(item));
    vi.mocked(repo.getWorkItemPayload).mockResolvedValue(null);
    vi.mocked(repo.markWorkFailed).mockResolvedValue(true);
    const execute = vi.fn();

    await expect(runReviewWorkItem({ execute })).rejects.toThrow(
      /Invalid review work item payload/,
    );

    expect(repo.markWorkFailed).toHaveBeenCalledWith(
      pool,
      "wi-1",
      expect.objectContaining({ name: "WorkItemPayloadValidationError" }),
      1,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns without executing when item is null", async () => {
    mockFetchedItem(null);
    const execute = vi.fn();
    await runReviewWorkItem({ execute });
    expect(execute).not.toHaveBeenCalled();
    expect(repo.claimWorkForExecution).not.toHaveBeenCalled();
  });

  it("returns without executing when item type mismatches", async () => {
    mockFetchedItem(makeAskWorkItem({ status: "queued" }));
    const execute = vi.fn();
    await runReviewWorkItem({ execute });
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns without executing when acceptItem rejects", async () => {
    mockFetchedItem(makeItem());
    const execute = vi.fn();
    await runReviewWorkItem({
      acceptItem: () => false,
      execute,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("cancels and returns before claim when shouldSkipWork is true", async () => {
    mockFetchedItem(makeItem());
    vi.mocked(repo.shouldSkipWork).mockResolvedValueOnce(true);
    const execute = vi.fn();

    await runReviewWorkItem({ execute });

    expect(repo.markWorkCancelled).toHaveBeenCalledWith(pool, "wi-1", undefined);
    expect(repo.claimWorkForExecution).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("invokes onCancelled when cancelled before execution", async () => {
    mockFetchedItem(makeItem());
    vi.mocked(repo.shouldSkipWork).mockResolvedValueOnce(true);
    const execute = vi.fn();
    const onCancelled = vi.fn().mockResolvedValue(undefined);

    await runReviewWorkItem({ execute, onCancelled });

    expect(execute).not.toHaveBeenCalled();
    expect(onCancelled).toHaveBeenCalledTimes(1);
    expect(onCancelled).toHaveBeenCalledWith(
      expect.objectContaining({ id: "wi-1", installationId: 42 }),
      expect.objectContaining({ owner: "o", repo: "r" }),
      "skipped_before_claim",
    );
  });

  it("releases the lease and returns without executing when claim fails", async () => {
    const item = makeItem();
    mockFetchedItem(item);
    vi.mocked(repo.claimWorkForExecution).mockResolvedValue(false);
    const execute = vi.fn();

    await runReviewWorkItem({ execute });

    expect(execute).not.toHaveBeenCalled();
    expect(repo.markWorkCancelled).not.toHaveBeenCalled();
    expect(prActorLease.releasePrActorLease).toHaveBeenCalledWith(pool, {
      resourceKey: item.resourceKey,
      workType: "review",
      leaseEpoch: 1,
    });
  });

  it("cancels when payload.commenterId matches bot identity", async () => {
    mockFetchedItem(
      makeItem({
        payload: { mode: "review", source: "slash", commenterId: 999 },
      }),
    );
    const execute = vi.fn();

    await runReviewWorkItem({ execute });

    expect(execute).not.toHaveBeenCalled();
    expect(repo.markWorkCancelled).toHaveBeenCalledWith(pool, "wi-1", 1);
  });

  it("single-flights concurrent installation token mints", async () => {
    clearDurableAuthCachesForTest();
    let releaseMint!: () => void;
    const mintGate = new Promise<void>((resolve) => {
      releaseMint = resolve;
    });
    vi.mocked(appAuth.mintInstallationAuth).mockImplementation(
      () =>
        new Promise((resolve) => {
          mintGate.then(() =>
            resolve({
              type: "token",
              tokenType: "installation",
              token: "tok",
              expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
              installationId: 42,
            } as Awaited<ReturnType<typeof appAuth.mintInstallationAuth>>),
          );
        }),
    );

    const pending = Promise.all([mintInstallationToken(cfg, 42), mintInstallationToken(cfg, 42)]);
    await Promise.resolve();
    expect(appAuth.mintInstallationAuth).toHaveBeenCalledTimes(1);
    releaseMint();
    const [first, second] = await pending;
    expect(first.token).toBe("tok");
    expect(second.token).toBe("tok");
  });

  it("reuses installation token and app bot identity across jobs", async () => {
    const first = makeItem({
      payload: { mode: "review", source: "slash", commenterId: 1 },
    });
    const second = makeItem({
      id: "wi-2",
      payload: { mode: "review", source: "slash", commenterId: 1 },
    });
    mockFetchedItems(first, second);
    const execute = vi.fn().mockResolvedValue(completedResult());

    await runReviewWorkItem({ execute });
    await runReviewWorkItem({ job: makeJob(), execute });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(appAuth.mintInstallationAuth).toHaveBeenCalledTimes(1);
    expect(appAuth.getAppBotIdentity).toHaveBeenCalledTimes(1);
  });

  it("refreshes stale installation tokens", async () => {
    clearDurableAuthCachesForTest();
    vi.mocked(appAuth.mintInstallationAuth)
      .mockResolvedValueOnce({
        type: "token",
        tokenType: "installation",
        token: "old-token",
        expiresAt: new Date(Date.now() + 1_000).toISOString(),
        installationId: 42,
      } as Awaited<ReturnType<typeof appAuth.mintInstallationAuth>>)
      .mockResolvedValueOnce({
        type: "token",
        tokenType: "installation",
        token: "new-token",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        installationId: 42,
      } as Awaited<ReturnType<typeof appAuth.mintInstallationAuth>>);

    const first = await mintInstallationToken(cfg, 42);
    const second = await mintInstallationToken(cfg, 42);

    expect(first.token).toBe("old-token");
    expect(second.token).toBe("new-token");
    expect(appAuth.mintInstallationAuth).toHaveBeenCalledTimes(2);
  });

  it("returns when updateRunningWorkHeadSha races and rejects the update", async () => {
    mockFetchedItem(makeItem());
    vi.mocked(repo.updateRunningWorkHeadSha).mockResolvedValue(false);
    vi.mocked(repo.shouldSkipWork).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const execute = vi.fn();

    await runReviewWorkItem({ execute });

    expect(execute).not.toHaveBeenCalled();
    expect(repo.markWorkCancelled).toHaveBeenCalledWith(pool, "wi-1", 1);
    expect(repo.markWorkCompleted).not.toHaveBeenCalled();
  });

  it("invokes onCancelled when head update loses to a cancellation", async () => {
    mockFetchedItem(makeItem());
    vi.mocked(repo.updateRunningWorkHeadSha).mockResolvedValue(false);
    vi.mocked(repo.shouldSkipWork).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const execute = vi.fn();
    const onCancelled = vi.fn().mockResolvedValue(undefined);

    await runReviewWorkItem({ execute, onCancelled });

    expect(execute).not.toHaveBeenCalled();
    expect(onCancelled).toHaveBeenCalledWith(
      expect.objectContaining({ id: "wi-1" }),
      expect.objectContaining({ owner: "o", repo: "r" }),
      "head_update_rejected",
    );
  });

  it("marks publish degraded when execute reports completed+degraded", async () => {
    mockFetchedItem(makeItem());
    const execute = vi.fn().mockResolvedValue(completedResult(true));

    await runReviewWorkItem({ execute });

    expect(repo.markWorkPublishDegraded).toHaveBeenCalledWith(pool, "wi-1", 1);
    expect(repo.markWorkCompleted).toHaveBeenCalled();
  });

  it("publishes plus-one outcome reaction after successful completion", async () => {
    mockFetchedItem(
      makeItem({
        payload: {
          mode: "review",
          source: "auto",
          ackTargets: [{ kind: "pr", prNumber: 1 }],
        },
      }),
    );
    const execute = vi.fn().mockResolvedValue(completedResult());

    await runReviewWorkItem({ execute });

    expect(prSurfaceMocks.setAcknowledgementReaction).toHaveBeenCalledWith(
      [{ kind: "pr", prNumber: 1 }],
      GITHUB_REACTION_PLUS_ONE,
    );
  });

  it("publishes minus-one outcome reaction after terminal failure", async () => {
    mockFetchedItem(
      makeItem({
        payload: {
          mode: "review",
          source: "auto",
          ackTargets: [{ kind: "pr", prNumber: 1 }],
        },
      }),
    );
    const execute = vi.fn().mockRejectedValue(new Error("dead"));

    await runReviewWorkItem({ job: makeJob(3, 3), execute });

    expect(prSurfaceMocks.setAcknowledgementReaction).toHaveBeenCalledWith(
      [{ kind: "pr", prNumber: 1 }],
      GITHUB_REACTION_MINUS_ONE,
    );
  });

  it("does not publish outcome reaction when cancelled after execute", async () => {
    mockFetchedItem(makeItem());
    vi.mocked(repo.shouldSkipWork).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const execute = vi.fn().mockResolvedValue(completedResult());

    await runReviewWorkItem({ execute });

    expect(repo.markWorkCancelled).toHaveBeenCalled();
    expect(prSurfaceMocks.setAcknowledgementReaction).not.toHaveBeenCalled();
  });

  it("on non-terminal pg-boss attempt: marks retrying and rethrows", async () => {
    mockFetchedItem(makeItem());
    const boom = new Error("transient");
    const execute = vi.fn().mockRejectedValue(boom);

    await expect(runReviewWorkItem({ job: makeJob(0, 3), execute })).rejects.toBe(boom);

    expect(repo.markWorkRetrying).toHaveBeenCalledWith(pool, "wi-1", boom, 1);
    expect(repo.markWorkFailed).not.toHaveBeenCalled();
  });

  it("terminal-fails stale-head replacement exhaustion without durable retry", async () => {
    mockFetchedItem(makeItem());
    const { AppError } = await import("../src/errors/appError.js");
    const boom = new AppError({
      code: reviewReschedule.STALE_HEAD_REPLACEMENT_EXHAUSTED,
      message: "Stale-head replacement went stale again. Run /review to retry on the latest head.",
    });
    const onTerminalFailure = vi.fn().mockResolvedValue(undefined);
    const execute = vi.fn().mockRejectedValue(boom);

    await runReviewWorkItem({ job: makeJob(0, 3), execute, onTerminalFailure });

    expect(repo.markWorkRetrying).not.toHaveBeenCalled();
    expect(repo.markWorkFailed).toHaveBeenCalledWith(pool, "wi-1", boom, 1);
    expect(onTerminalFailure).toHaveBeenCalledTimes(1);
    expect(onTerminalFailure).toHaveBeenCalledWith(
      expect.objectContaining({ id: "wi-1" }),
      expect.anything(),
      boom,
    );
  });

  it("on terminal pg-boss attempt: marks failed and invokes onTerminalFailure", async () => {
    mockFetchedItem(makeItem());
    const boom = new Error("dead");
    const execute = vi.fn().mockRejectedValue(boom);
    const onTerminalFailure = vi.fn().mockResolvedValue(undefined);

    await runReviewWorkItem({ job: makeJob(3, 3), execute, onTerminalFailure });

    expect(repo.markWorkFailed).toHaveBeenCalledWith(pool, "wi-1", boom, 1);
    expect(onTerminalFailure).toHaveBeenCalledTimes(1);
    const [itemArg, surfaceArg, errArg] = onTerminalFailure.mock.calls[0];
    expect(itemArg.id).toBe("wi-1");
    expect(surfaceArg).toMatchObject({ owner: "o", repo: "r" });
    expect(errArg).toBe(boom);
  });

  it("onTerminalFailure errors are caught (no rethrow)", async () => {
    mockFetchedItem(makeItem());
    const execute = vi.fn().mockRejectedValue(new Error("dead"));
    const onTerminalFailure = vi.fn().mockRejectedValue(new Error("hook boom"));

    await expect(
      runReviewWorkItem({ job: makeJob(3, 3), execute, onTerminalFailure }),
    ).resolves.toBeUndefined();
  });

  it("terminal failure with markWorkFailed=false skips onTerminalFailure", async () => {
    mockFetchedItem(makeItem());
    vi.mocked(repo.markWorkFailed).mockResolvedValue(false);
    const execute = vi.fn().mockRejectedValue(new Error("dead"));
    const onTerminalFailure = vi.fn();

    await runReviewWorkItem({ job: makeJob(3, 3), execute, onTerminalFailure });

    expect(onTerminalFailure).not.toHaveBeenCalled();
  });

  it("completes rescheduled parent via force mark when markWorkCompleted races", async () => {
    mockFetchedItem(
      makeItem({
        status: "running",
        payload: {
          mode: "review",
          source: "slash",
          staleHeadReplacement: {
            replacementWorkItemId: "replacement-wi",
            state: "pending-enqueue",
          },
        },
      }),
    );
    vi.mocked(repo.markWorkCompleted).mockResolvedValue(false);
    vi.mocked(repo.forceMarkRescheduledParentCompleted).mockResolvedValue(true);
    const afterComplete = vi.fn().mockResolvedValue(undefined);
    const execute = vi.fn().mockResolvedValue(rescheduledResult({ afterComplete }));

    await runReviewWorkItem({ execute });

    expect(afterComplete).toHaveBeenCalledWith(boss);
    expect(repo.forceMarkRescheduledParentCompleted).toHaveBeenCalledWith(pool, "wi-1");
    expect(repo.markWorkFailed).not.toHaveBeenCalled();
  });

  it("still enqueues a stale-head replacement when parent becomes skippable after execute", async () => {
    mockFetchedItem(
      makeItem({
        status: "running",
        payload: {
          mode: "review",
          source: "auto",
          staleHeadReplacement: {
            replacementWorkItemId: "replacement-wi",
            state: "pending-enqueue",
          },
        },
      }),
    );
    // cancelBeforeClaim is false; finishRescheduledParentWorkItem then sees cancel_requested.
    vi.mocked(repo.shouldSkipWork).mockResolvedValueOnce(false).mockResolvedValue(true);
    vi.mocked(repo.markWorkCompleted).mockResolvedValue(false);
    vi.mocked(repo.forceMarkRescheduledParentCompleted).mockResolvedValue(false);
    const afterComplete = vi.fn().mockResolvedValue(undefined);
    const execute = vi.fn().mockResolvedValue(rescheduledResult({ afterComplete }));

    await runReviewWorkItem({ execute });

    expect(afterComplete).toHaveBeenCalledWith(boss);
    expect(repo.markWorkCancelled).toHaveBeenCalledWith(pool, "wi-1", 1);
  });

  it("throws when rescheduled parent cannot be completed and replacement marker exists", async () => {
    mockFetchedItem(
      makeItem({
        status: "running",
        payload: {
          mode: "review",
          source: "slash",
          staleHeadReplacement: {
            replacementWorkItemId: "replacement-wi",
            state: "pending-enqueue",
          },
        },
      }),
    );
    vi.mocked(repo.markWorkCompleted).mockResolvedValue(false);
    vi.mocked(repo.forceMarkRescheduledParentCompleted).mockResolvedValue(false);
    const execute = vi.fn().mockResolvedValue(rescheduledResult());

    await expect(runReviewWorkItem({ job: makeJob(0, 3), execute })).rejects.toThrow(
      /Failed to complete rescheduled parent/,
    );

    expect(repo.markWorkRetrying).toHaveBeenCalled();
  });

  it("leaves queued replacement intact after transient afterComplete failure", async () => {
    mockFetchedItem(
      makeItem({
        status: "running",
        payload: {
          mode: "review",
          source: "slash",
          staleHeadReplacement: {
            replacementWorkItemId: "replacement-wi",
            state: "pending-enqueue",
          },
        },
      }),
    );
    const boom = new Error("enqueue failed");
    const onRescheduleAbort = vi.fn();
    const execute = vi.fn().mockResolvedValue(
      rescheduledResult({
        afterComplete: vi.fn().mockRejectedValue(boom),
        onRescheduleAbort,
      }),
    );

    await expect(runReviewWorkItem({ job: makeJob(0, 3), execute })).rejects.toBe(boom);

    expect(repo.markWorkRetrying).toHaveBeenCalledWith(pool, "wi-1", boom, 1);
    expect(onRescheduleAbort).not.toHaveBeenCalled();
    expect(repo.markWorkFailed).not.toHaveBeenCalled();
  });

  it("invokes onRescheduleAbort on terminal afterComplete failure", async () => {
    mockFetchedItem(
      makeItem({
        status: "running",
        payload: {
          mode: "review",
          source: "slash",
          staleHeadReplacement: {
            replacementWorkItemId: "replacement-wi",
            state: "pending-enqueue",
          },
        },
      }),
    );
    const boom = new Error("enqueue failed");
    const onRescheduleAbort = vi.fn().mockResolvedValue(undefined);
    const execute = vi.fn().mockResolvedValue(
      rescheduledResult({
        afterComplete: vi.fn().mockRejectedValue(boom),
        onRescheduleAbort,
      }),
    );

    await runReviewWorkItem({ job: makeJob(3, 3), execute });

    expect(repo.markWorkFailed).toHaveBeenCalledWith(pool, "wi-1", boom, 1);
    expect(onRescheduleAbort).toHaveBeenCalledWith(boss, boom);
    expect(repo.markWorkRetrying).not.toHaveBeenCalled();
    expect(
      reviewReschedule.cancelOrphanedStaleHeadReplacementOnTerminalFailure,
    ).not.toHaveBeenCalled();
  });

  it("does not invoke onRescheduleAbort when execute fails without a reschedule result", async () => {
    mockFetchedItem(
      makeItem({
        status: "running",
        payload: {
          mode: "review",
          source: "slash",
          staleHeadReplacement: {
            replacementWorkItemId: "replacement-wi",
            state: "enqueued",
          },
        },
      }),
    );
    const boom = new Error("dead");
    const onRescheduleAbort = vi.fn();
    const execute = vi.fn().mockRejectedValue(boom);

    await runReviewWorkItem({ job: makeJob(3, 3), execute });

    expect(repo.markWorkFailed).toHaveBeenCalledWith(pool, "wi-1", boom, 1);
    expect(onRescheduleAbort).not.toHaveBeenCalled();
    expect(
      reviewReschedule.cancelOrphanedStaleHeadReplacementOnTerminalFailure,
    ).toHaveBeenCalledWith(pool, boss, expect.objectContaining({ id: "wi-1" }), boom);
  });

  it("cancels orphaned replacement via payload marker on terminal failure without abort hook", async () => {
    const item = makeItem({
      status: "running",
      payload: {
        mode: "review",
        source: "slash",
        staleHeadReplacement: {
          replacementWorkItemId: "replacement-wi",
          state: "pending-enqueue",
        },
      },
    });
    mockFetchedItem(item);
    const boom = new Error("github head sha failed");
    const execute = vi.fn().mockRejectedValue(boom);

    await runReviewWorkItem({ job: makeJob(3, 3), execute });

    expect(repo.markWorkFailed).toHaveBeenCalledWith(pool, "wi-1", boom, 1);
    expect(
      reviewReschedule.cancelOrphanedStaleHeadReplacementOnTerminalFailure,
    ).toHaveBeenCalledWith(pool, boss, item, boom);
  });

  it("clears pending onRescheduleAbort after successful afterComplete", async () => {
    mockFetchedItem(
      makeItem({
        status: "running",
        payload: {
          mode: "review",
          source: "slash",
          staleHeadReplacement: {
            replacementWorkItemId: "replacement-wi",
            state: "pending-enqueue",
          },
        },
      }),
    );
    vi.mocked(repo.markWorkCompleted).mockResolvedValue(false);
    vi.mocked(repo.forceMarkRescheduledParentCompleted).mockResolvedValue(false);
    const onRescheduleAbort = vi.fn();
    const execute = vi.fn().mockResolvedValue(rescheduledResult({ onRescheduleAbort }));

    await expect(runReviewWorkItem({ job: makeJob(0, 3), execute })).rejects.toThrow(
      /Failed to complete rescheduled parent/,
    );

    expect(onRescheduleAbort).not.toHaveBeenCalled();
    expect(repo.markWorkRetrying).toHaveBeenCalled();
  });

  it("warns and continues terminal failure when onRescheduleAbort throws", async () => {
    mockFetchedItem(
      makeItem({
        status: "running",
        payload: {
          mode: "review",
          source: "slash",
          staleHeadReplacement: {
            replacementWorkItemId: "replacement-wi",
            state: "pending-enqueue",
          },
        },
      }),
    );
    const boom = new Error("enqueue failed");
    const onTerminalFailure = vi.fn().mockResolvedValue(undefined);
    const onRescheduleAbort = vi.fn().mockRejectedValue(new Error("cancel blew up"));
    const execute = vi.fn().mockResolvedValue(
      rescheduledResult({
        afterComplete: vi.fn().mockRejectedValue(boom),
        onRescheduleAbort,
      }),
    );

    await expect(
      runReviewWorkItem({ job: makeJob(3, 3), execute, onTerminalFailure }),
    ).resolves.toBeUndefined();

    expect(repo.markWorkFailed).toHaveBeenCalledWith(pool, "wi-1", boom, 1);
    expect(onRescheduleAbort).toHaveBeenCalledWith(boss, boom);
    expect(evlog.logWarn).toHaveBeenCalledWith(
      "agent_work_replacement_cancel_failed",
      expect.objectContaining({
        type: "review",
        workItemId: "wi-1",
        message: expect.stringMatching(/cancel blew up/),
      }),
    );
    expect(onTerminalFailure).toHaveBeenCalledTimes(1);
    expect(evlog.logError).toHaveBeenCalledWith(
      "agent_work_failed",
      expect.objectContaining({
        type: "review",
        workItemId: "wi-1",
        owner: "o",
        repo: "r",
        pr_number: 1,
      }),
      boom,
    );
  });

  it("swallows lease-lost errors without terminalising", async () => {
    mockFetchedItem(makeItem());
    const { AppError } = await import("../src/errors/appError.js");
    const boom = new AppError({
      code: "agent_work.pr_actor_lease_lost",
      message: "PR actor lease is no longer held by this execution",
    });
    const execute = vi.fn().mockRejectedValue(boom);

    await runReviewWorkItem({ job: makeJob(3, 3), execute });

    expect(repo.markWorkFailed).not.toHaveBeenCalled();
    expect(repo.markWorkRetrying).not.toHaveBeenCalled();
    expect(repo.markWorkCancelled).not.toHaveBeenCalled();
    expect(evlog.logInfo).toHaveBeenCalledWith(
      "agent_work_stale_execution_skipped",
      expect.objectContaining({ workItemId: "wi-1", leaseEpoch: 1 }),
    );
  });

  it("cancels with the lease epoch when the job signal is aborted after claim", async () => {
    const item = makeItem({ status: "running" });
    mockFetchedItem(item);
    const controller = new AbortController();
    vi.mocked(repo.claimWorkForExecution).mockImplementation(async () => {
      controller.abort();
      return true;
    });
    const execute = vi.fn();

    await runReviewWorkItem({
      job: { ...makeJob(), signal: controller.signal },
      execute,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(repo.markWorkCancelled).toHaveBeenCalledWith(pool, "wi-1", 1);
  });

  it("does not cancel a newer execution when abort races a lost lease", async () => {
    const item = makeItem({ status: "running" });
    mockFetchedItem(item);
    vi.mocked(prActorLease.isPrActorLeaseHeld).mockResolvedValue(false);
    const controller = new AbortController();
    vi.mocked(repo.claimWorkForExecution).mockImplementation(async () => {
      controller.abort();
      return true;
    });
    const execute = vi.fn();

    await runReviewWorkItem({
      job: { ...makeJob(), signal: controller.signal },
      execute,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(repo.markWorkCancelled).not.toHaveBeenCalled();
    expect(evlog.logInfo).toHaveBeenCalledWith(
      "agent_work_stale_execution_skipped",
      expect.objectContaining({ workItemId: "wi-1", leaseEpoch: 1 }),
    );
  });

  it("cancels before claim when the job signal is aborted pre-claim", async () => {
    mockFetchedItem(makeItem());
    const controller = new AbortController();
    controller.abort();
    const execute = vi.fn();

    await runReviewWorkItem({
      job: { ...makeJob(), signal: controller.signal },
      execute,
    });

    expect(repo.claimWorkForExecution).not.toHaveBeenCalled();
    expect(repo.markWorkCancelled).toHaveBeenCalledWith(pool, "wi-1", undefined);
    expect(execute).not.toHaveBeenCalled();
  });

  it("recovers replacement on retry after transient afterComplete failure", async () => {
    const item = makeItem({
      status: "running",
      payload: {
        mode: "review",
        source: "slash",
        staleHeadReplacement: {
          replacementWorkItemId: "replacement-wi",
          state: "pending-enqueue",
        },
      },
    });
    mockFetchedItem(item);
    const boom = new Error("enqueue failed");
    const afterComplete = vi.fn().mockRejectedValueOnce(boom).mockResolvedValueOnce(undefined);
    const onRescheduleAbort = vi.fn();
    const execute = vi
      .fn()
      .mockResolvedValue(rescheduledResult({ afterComplete, onRescheduleAbort }));

    await expect(runReviewWorkItem({ job: makeJob(0, 3), execute })).rejects.toBe(boom);
    expect(onRescheduleAbort).not.toHaveBeenCalled();
    expect(repo.markWorkRetrying).toHaveBeenCalledWith(pool, "wi-1", boom, 1);

    await runReviewWorkItem({ job: makeJob(1, 3), execute });

    expect(afterComplete).toHaveBeenCalledTimes(2);
    expect(repo.markWorkCompleted).toHaveBeenCalledWith(pool, "wi-1", 1);
    expect(onRescheduleAbort).not.toHaveBeenCalled();
  });
});

describe("DurableExecutionResult assignability", () => {
  it("accepts completed, completed-degraded, and fully specified rescheduled", () => {
    expectTypeOf({ kind: "completed" as const }).toMatchTypeOf<DurableExecutionResult>();
    expectTypeOf({
      kind: "completed" as const,
      degraded: true,
    }).toMatchTypeOf<DurableExecutionResult>();
    expectTypeOf({
      kind: "rescheduled" as const,
      replacementWorkItemId: "replacement-wi",
      afterComplete: async (_boss: PgBoss) => undefined,
      onRescheduleAbort: async (_boss: PgBoss, _error: unknown) => undefined,
    }).toMatchTypeOf<DurableExecutionResult>();
  });

  it("rejects incomplete reschedule and the old optional-flag shapes", () => {
    expectTypeOf<{ kind: "rescheduled" }>().not.toMatchTypeOf<DurableExecutionResult>();
    expectTypeOf<{ degraded: true }>().not.toMatchTypeOf<DurableExecutionResult>();
    expectTypeOf<{
      rescheduled: true;
      replacementWorkItemId: string;
      afterComplete: (boss: PgBoss) => Promise<void>;
      onRescheduleAbort: (boss: PgBoss, error: unknown) => Promise<void>;
    }>().not.toMatchTypeOf<DurableExecutionResult>();
  });

  it("constructs valid object literals", () => {
    const accept = (result: DurableExecutionResult): DurableExecutionResult => result;
    accept({ kind: "completed" });
    accept({ kind: "completed", degraded: true });
    accept({
      kind: "rescheduled",
      replacementWorkItemId: "replacement-wi",
      afterComplete: async () => undefined,
      onRescheduleAbort: async () => undefined,
    });
  });
});
