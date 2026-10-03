import { createFakePublishStore } from "../src/agentWork/fakePublishStore.js";
const publishStoreState = vi.hoisted(() => {
  let store: import("../src/agentWork/publishOnce.js").PublishIntentStore;
  return {
    get store() {
      return store;
    },
    set store(value) {
      store = value;
    },
  };
});
vi.mock("../src/agentWork/operationIntentRepository.js", () => ({
  persistOperationIntent: vi.fn(
    (...args: Parameters<typeof publishStoreState.store.persistOperationIntent>) =>
      publishStoreState.store.persistOperationIntent(...args),
  ),
  mergeOperationIntentDetail: vi.fn(
    (...args: Parameters<typeof publishStoreState.store.mergeOperationIntentDetail>) =>
      publishStoreState.store.mergeOperationIntentDetail(...args),
  ),
  reconcileOperationIntent: vi.fn(
    (...args: Parameters<typeof publishStoreState.store.reconcileOperationIntent>) =>
      publishStoreState.store.reconcileOperationIntent(...args),
  ),
  getOperationIntent: vi.fn(
    (...args: Parameters<typeof publishStoreState.store.getOperationIntent>) =>
      publishStoreState.store.getOperationIntent(...args),
  ),
  listPendingOperationIntents: vi.fn(
    (...args: Parameters<typeof publishStoreState.store.listPendingOperationIntents>) =>
      publishStoreState.store.listPendingOperationIntents(...args),
  ),
}));
beforeEach(() => {
  publishStoreState.store = createFakePublishStore();
});
vi.mock("../src/agentWork/reconcilePendingIntents.js", () => ({
  reconcilePendingIntents: vi.fn(async () => ({ reconciled: 0, stillPending: 0 })),
  findCompletedPublishRecordId: vi.fn(async () => null),
}));
import { createWorkDefinitions } from "../src/agentWork/workDefinition.js";
import { openInstallationSurface } from "../src/agentWork/installationSurface.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Pool } from "pg";
import { AppError } from "../src/errors/appError.js";
import {
  createDurableRuntime,
  runDurableWorkItem,
  type DurableExecutionResult,
  type DurableJobSpec,
} from "../src/agentWork/durableJob.js";
import type { AgentWorkItem } from "../src/agentWork/types.js";
import { makeAskWorkItem, makeReviewWorkItem } from "./helpers/agentWorkItems.js";
import { makeTestConfig } from "./helpers/config.js";
import { DEFERRED_HEAD_SHA } from "../src/settings/index.js";
import { coreOf } from "./helpers/executorDurableHarness.js";
import type { PoolClient } from "pg";

vi.mock("../src/agentWork/workItemStateRepository.js", () => ({
  getWorkItem: vi.fn(),
  getWorkItemCore: vi.fn(),
  getWorkItemPayload: vi.fn(),
  shouldSkipWork: vi.fn(),
  markWorkCancelled: vi.fn(),
  markQueuedWorkCancelled: vi.fn(),
  claimWorkForExecution: vi.fn(),
  beginWorkAttempt: vi.fn(),
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

import * as repo from "../src/agentWork/workItemStateRepository.js";
import * as prActorLease from "../src/agentWork/prActorLease.js";
import * as appAuth from "../src/github/appAuth.js";
import * as prSurface from "../src/github/prSurface.js";
import * as evlog from "../src/evlog.js";
import { mockWorkClaim } from "./helpers/executorDurableHarness.js";

let installationSurface = openInstallationSurface();

const cfg = makeTestConfig();
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

function makeJob(retryCount = 0, retryLimit = 3): JobWithMetadata<{ workItemId: string }> {
  return {
    id: "job-1",
    data: { workItemId: "wi-1" },
    retryCount,
    retryLimit,
    signal: new AbortController().signal,
  } as unknown as JobWithMetadata<{ workItemId: string }>;
}

function completedResult(degradation?: readonly string[]): DurableExecutionResult {
  return degradation ? { kind: "completed", degradation } : { kind: "completed" };
}

function runReviewWorkItem(
  overrides: Partial<DurableJobSpec<"review">> & Pick<DurableJobSpec<"review">, "execute">,
): Promise<void> {
  return runDurableWorkItem({
    contextPolicy: createWorkDefinitions({ cfg, pool, boss }).review.contextPolicy,
    cfg,
    pool,
    boss,
    job: makeJob(),
    type: "review",
    prActorLease: { queue: "agent-work-review" },
    resolveHeadSha: async () => ({ headSha: "x" }),
    // Unit pool is a `{}` stub with mocked repositories: run the atomic body
    // without a real transaction (mocked acquire/claim/release ignore it).
    runtime: createDurableRuntime({
      installationSurface,
      transaction: async (_pool, fn) => fn(pool as unknown as PoolClient),
    }),
    ...overrides,
    execute: async (item, env) => {
      await env.beginAttempt();
      return overrides.execute(item, env);
    },
  });
}

function defaultMocks() {
  vi.mocked(repo.getWorkItem).mockReset();
  vi.mocked(repo.getWorkItemCore).mockReset();
  vi.mocked(repo.getWorkItemPayload).mockReset();
  vi.mocked(repo.shouldSkipWork).mockResolvedValue(false);
  vi.mocked(repo.claimWorkForExecution).mockResolvedValue({
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    startedAt: new Date("2026-01-01T00:00:05.000Z"),
    attemptCount: 1,
    resumed: false,
  });
  vi.mocked(repo.beginWorkAttempt).mockImplementation(async () => {
    const claim = await vi.mocked(repo.claimWorkForExecution).mock.results.at(-1)?.value;
    if (!claim) throw new Error("missing mocked lifecycle claim");
    return claim.attemptCount > cfg.queue.retryLimit + 1
      ? { kind: "exhausted", attemptCount: claim.attemptCount }
      : { kind: "started", claim };
  });
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
  installationSurface = openInstallationSurface();
  vi.mocked(appAuth.getAppBotIdentity).mockResolvedValue({
    userId: 999,
    login: "pr-agent[bot]",
  });
}

async function expectNoFurtherLeaseRenewal(): Promise<void> {
  const renewals = vi.mocked(prActorLease.renewPrActorLease).mock.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(prActorLease.renewPrActorLease).toHaveBeenCalledTimes(renewals);
}

describe("leased execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    defaultMocks();
  });
  it("claims through the unified path and acquires the PR actor lease", async () => {
    const item = makeItem();
    mockFetchedItem(item);
    const execute = vi.fn().mockResolvedValue(completedResult());

    await runReviewWorkItem({ resolveHeadSha: async () => ({ headSha: "abc123" }), execute });

    expect(repo.getWorkItemCore).toHaveBeenCalledWith(pool, "wi-1");
    expect(repo.claimWorkForExecution).toHaveBeenCalledWith(pool, "wi-1", 1);
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
    const completeOrder = vi.mocked(repo.markWorkCompleted).mock.invocationCallOrder[0];
    const releaseOrder = vi.mocked(prActorLease.releasePrActorLease).mock.invocationCallOrder[0];
    expect(completeOrder).toBeDefined();
    expect(releaseOrder).toBeDefined();
    expect(completeOrder).toBeLessThan(releaseOrder ?? 0);
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

  it("defers deferred-head work while the PR actor lease is held, then resolves head on claim", async () => {
    const item = makeItem({ headSha: DEFERRED_HEAD_SHA });
    const resolveHeadSha = vi.fn(async () => ({ headSha: "resolved-head" }));
    const execute = vi.fn().mockResolvedValue(completedResult());

    mockFetchedItem(item);
    vi.mocked(prActorLease.acquirePrActorLease).mockResolvedValueOnce({
      acquired: false,
      heldByWorkItemId: "wi-other",
      leaseEpoch: 7,
    });
    await runReviewWorkItem({ resolveHeadSha, execute });
    expect(execute).not.toHaveBeenCalled();
    expect(resolveHeadSha).not.toHaveBeenCalled();

    mockFetchedItem(item);
    await runReviewWorkItem({ resolveHeadSha, execute });
    expect(resolveHeadSha).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1].headSha).toBe("resolved-head");
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
      expect.objectContaining({ key: "wi-1" }),
    );
    expect(boss.findJobs).toHaveBeenCalledWith(
      "agent-work-review",
      expect.not.objectContaining({ queued: true }),
    );
    expect(repo.claimWorkForExecution).not.toHaveBeenCalled();
    expect(repo.markWorkFailed).not.toHaveBeenCalled();
  });

  it("throws when a lease deferral send is swallowed and only active deliveries remain", async () => {
    const item = makeItem();
    mockFetchedItem(item);
    vi.mocked(prActorLease.acquirePrActorLease).mockResolvedValue({
      acquired: false,
      heldByWorkItemId: "wi-other",
      leaseEpoch: 7,
    });
    vi.mocked(boss.send).mockResolvedValue(null);
    vi.mocked(boss.findJobs).mockResolvedValue([{ id: "hop-1", state: "active" }] as never);

    await expect(runReviewWorkItem({ execute: vi.fn() })).rejects.toMatchObject({
      code: "agent_work.lease_watchdog_arm_failed",
    });

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
    const retryOrder = vi.mocked(repo.markWorkRetrying).mock.invocationCallOrder[0];
    const releaseOrder = vi.mocked(prActorLease.releasePrActorLease).mock.invocationCallOrder[0];
    expect(retryOrder).toBeDefined();
    expect(releaseOrder).toBeDefined();
    expect(retryOrder).toBeLessThan(releaseOrder ?? 0);
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

    expect(repo.claimWorkForExecution).toHaveBeenCalledWith(pool, "wi-1", 1);
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

    expect(repo.claimWorkForExecution).toHaveBeenCalledWith(pool, "wi-1", 1);
    expect(repo.markWorkFailed).toHaveBeenCalledWith(
      pool,
      "wi-1",
      expect.objectContaining({ name: "WorkItemPayloadValidationError" }),
      1,
    );
    expect(prActorLease.releasePrActorLease).toHaveBeenCalledWith(pool, {
      resourceKey: item.resourceKey,
      workType: "review",
      leaseEpoch: 1,
    });
    const failOrder = vi.mocked(repo.markWorkFailed).mock.invocationCallOrder[0];
    const releaseOrder = vi.mocked(prActorLease.releasePrActorLease).mock.invocationCallOrder[0];
    expect(failOrder).toBeDefined();
    expect(releaseOrder).toBeDefined();
    expect(failOrder).toBeLessThan(releaseOrder ?? 0);
    expect(execute).not.toHaveBeenCalled();
  });

  it("passes resolved pull payload into execution context", async () => {
    const item = makeItem();
    mockFetchedItem(item);
    const pullRequest = {
      additions: 1,
      deletions: 0,
      title: "",
      body: null,
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

    expect(repo.claimWorkForExecution).toHaveBeenCalledWith(pool, "wi-1", 1);
    expect(execute).not.toHaveBeenCalled();
    expect(repo.markWorkCompleted).not.toHaveBeenCalled();
    expect(repo.markWorkFailed).not.toHaveBeenCalled();
    expect(prActorLease.releasePrActorLease).toHaveBeenCalledWith(pool, {
      resourceKey: item.resourceKey,
      workType: "review",
      leaseEpoch: 1,
    });
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

    expect(repo.markWorkCancelled).toHaveBeenCalledWith(pool, "wi-1", null);
    expect(repo.claimWorkForExecution).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not invoke a leased cancellation hook before acquiring an epoch", async () => {
    mockFetchedItem(makeItem());
    vi.mocked(repo.shouldSkipWork).mockResolvedValueOnce(true);
    const execute = vi.fn();
    const onCancelled = vi.fn().mockResolvedValue(undefined);

    await runReviewWorkItem({ execute, onCancelled });

    expect(execute).not.toHaveBeenCalled();
    expect(onCancelled).not.toHaveBeenCalled();
  });

  it("releases the lease and returns without executing when claim fails", async () => {
    const item = makeItem();
    mockFetchedItem(item);
    vi.mocked(repo.claimWorkForExecution).mockResolvedValue(null);
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

  it("releases the owned epoch and stops renewal when claim rejects", async () => {
    const item = makeItem();
    mockFetchedItem(item);
    const claimError = new Error("claim unavailable");
    vi.mocked(repo.claimWorkForExecution).mockRejectedValue(claimError);
    const execute = vi.fn();

    await expect(
      runReviewWorkItem({
        cfg: { ...cfg, queue: { ...cfg.queue, prActorLeaseRenewalIntervalSeconds: 0.001 } },
        execute,
      }),
    ).rejects.toBe(claimError);

    expect(execute).not.toHaveBeenCalled();
    expect(repo.markWorkFailed).not.toHaveBeenCalled();
    expect(prActorLease.releasePrActorLease).toHaveBeenCalledTimes(1);
    expect(prActorLease.releasePrActorLease).toHaveBeenCalledWith(pool, {
      resourceKey: item.resourceKey,
      workType: "review",
      leaseEpoch: 1,
    });
    await expectNoFurtherLeaseRenewal();
  });

  it("sends one hop total when the seed already armed a live hop", async () => {
    const item = makeItem();
    mockFetchedItem(item);
    vi.mocked(prActorLease.acquirePrActorLease).mockResolvedValue({
      acquired: false,
      heldByWorkItemId: "wi-other",
      leaseEpoch: 7,
    });
    // Seed send succeeds (returns a hop id): failed-acquire skips its send.
    vi.mocked(boss.send).mockResolvedValue("seed-hop");
    const execute = vi.fn();

    await runReviewWorkItem({ execute });

    expect(execute).not.toHaveBeenCalled();
    expect(repo.claimWorkForExecution).not.toHaveBeenCalled();
    // Seed (warn-and-proceed) armed the hop; the failed-acquire branch skips
    // its second send, so one send per cycle.
    expect(vi.mocked(boss.send)).toHaveBeenCalledTimes(1);
    expect(prActorLease.releasePrActorLease).not.toHaveBeenCalled();
  });

  it("re-arms strictly when the seed armed no live hop", async () => {
    const item = makeItem();
    mockFetchedItem(item);
    vi.mocked(prActorLease.acquirePrActorLease).mockResolvedValue({
      acquired: false,
      heldByWorkItemId: "wi-other",
      leaseEpoch: 7,
    });
    vi.mocked(boss.send).mockResolvedValue(null);
    vi.mocked(boss.findJobs)
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ id: "hop-1", state: "created" }] as never);
    const execute = vi.fn();

    await runReviewWorkItem({ execute });

    expect(execute).not.toHaveBeenCalled();
    // Seed found no live hop, failed-acquire re-armed strictly: two sends.
    expect(vi.mocked(boss.send)).toHaveBeenCalledTimes(2);
  });

  it("releases the named epoch on the client when claim rejects after acquire", async () => {
    const item = makeItem();
    mockFetchedItem(item);
    const claimError = new Error("claim unavailable");
    vi.mocked(repo.claimWorkForExecution).mockRejectedValue(claimError);
    const execute = vi.fn();

    await expect(runReviewWorkItem({ execute })).rejects.toBe(claimError);

    expect(execute).not.toHaveBeenCalled();
    // In-tx release on the client: outer runner state untouched, so a
    // deadlock retry would still own renewal and release on success.
    expect(prActorLease.releasePrActorLease).toHaveBeenCalledTimes(1);
    expect(prActorLease.releasePrActorLease).toHaveBeenCalledWith(pool, {
      resourceKey: item.resourceKey,
      workType: "review",
      leaseEpoch: 1,
    });
  });

  it("releases the owned epoch and stops renewal when payload read rejects", async () => {
    const item = makeItem();
    mockFetchedItem(item);
    const payloadError = new Error("payload unavailable");
    vi.mocked(repo.getWorkItemPayload).mockRejectedValue(payloadError);
    const execute = vi.fn();

    await expect(
      runReviewWorkItem({
        cfg: { ...cfg, queue: { ...cfg.queue, prActorLeaseRenewalIntervalSeconds: 0.001 } },
        execute,
      }),
    ).rejects.toBe(payloadError);

    expect(execute).not.toHaveBeenCalled();
    expect(repo.markWorkFailed).not.toHaveBeenCalled();
    expect(prActorLease.releasePrActorLease).toHaveBeenCalledTimes(1);
    expect(prActorLease.releasePrActorLease).toHaveBeenCalledWith(pool, {
      resourceKey: item.resourceKey,
      workType: "review",
      leaseEpoch: 1,
    });
    await expectNoFurtherLeaseRenewal();
  });

  it("cleans up after a malformed payload when the terminal write and release reject", async () => {
    const item = makeItem();
    vi.mocked(repo.getWorkItemCore).mockResolvedValue(coreOf(item));
    vi.mocked(repo.getWorkItemPayload).mockResolvedValue({ question: "not-a-review-payload" });
    const markError = new Error("mark failed");
    const releaseError = new Error("release failed");
    vi.mocked(repo.markWorkFailed).mockRejectedValue(markError);
    vi.mocked(prActorLease.releasePrActorLease).mockRejectedValue(releaseError);
    const execute = vi.fn();

    await expect(
      runReviewWorkItem({
        cfg: { ...cfg, queue: { ...cfg.queue, prActorLeaseRenewalIntervalSeconds: 0.001 } },
        execute,
      }),
    ).rejects.toThrow(/Invalid review work item payload/);

    expect(execute).not.toHaveBeenCalled();
    expect(repo.markWorkFailed).toHaveBeenCalledWith(
      pool,
      "wi-1",
      expect.objectContaining({ name: "WorkItemPayloadValidationError" }),
      1,
    );
    expect(evlog.logWarn).toHaveBeenCalledWith(
      "agent_work_failed_mark_failed",
      expect.objectContaining({
        workItemId: "wi-1",
        message: expect.stringMatching(/mark failed/),
      }),
    );
    expect(prActorLease.releasePrActorLease).toHaveBeenCalledTimes(1);
    expect(evlog.logWarn).toHaveBeenCalledWith(
      "pr_actor_lease_release_failed",
      expect.objectContaining({
        workItemId: "wi-1",
        leaseEpoch: 1,
        message: expect.stringMatching(/release failed/),
      }),
    );
    await expectNoFurtherLeaseRenewal();
  });

  it("does not acquire or release a PR actor lease for ask work", async () => {
    const item = makeAskWorkItem({ status: "queued" });
    mockFetchedItem(item);
    const execute = vi.fn().mockResolvedValue(completedResult());

    await runDurableWorkItem({
      contextPolicy: createWorkDefinitions({ cfg, pool, boss }).ask.contextPolicy,
      cfg,
      runtime: createDurableRuntime({ installationSurface }),
      pool,
      boss,
      job: makeJob(),
      type: "ask",
      resolveHeadSha: async () => ({ headSha: "x" }),
      execute,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1].leaseEpoch).toBeNull();
    expect(prActorLease.acquirePrActorLease).not.toHaveBeenCalled();
    expect(prActorLease.releasePrActorLease).not.toHaveBeenCalled();
    expect(prActorLease.renewPrActorLease).not.toHaveBeenCalled();
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

  it("returns when updateRunningWorkHeadSha races and rejects the update", async () => {
    mockFetchedItem(makeItem());
    vi.mocked(repo.updateRunningWorkHeadSha).mockResolvedValue(false);
    vi.mocked(repo.shouldSkipWork).mockResolvedValueOnce(false).mockResolvedValue(true);
    const execute = vi.fn();

    await runReviewWorkItem({ execute });

    expect(execute).not.toHaveBeenCalled();
    expect(repo.markWorkCancelled).toHaveBeenCalledWith(pool, "wi-1", 1);
    expect(repo.markWorkCompleted).not.toHaveBeenCalled();
  });

  it("invokes onCancelled when head update loses to a cancellation", async () => {
    mockFetchedItem(makeItem());
    vi.mocked(repo.updateRunningWorkHeadSha).mockResolvedValue(false);
    vi.mocked(repo.shouldSkipWork).mockResolvedValueOnce(false).mockResolvedValue(true);
    const execute = vi.fn();
    const onCancelled = vi.fn().mockResolvedValue(undefined);

    await runReviewWorkItem({ execute, onCancelled });

    expect(execute).not.toHaveBeenCalled();
    expect(onCancelled).toHaveBeenCalledWith(
      expect.objectContaining({ id: "wi-1" }),
      expect.objectContaining({ owner: "o", repo: "r" }),
      "head_update_rejected",
      1,
    );
  });

  it("runs cancellation cleanup when a head mismatch becomes skippable after execute", async () => {
    const item = makeItem({ status: "running" });
    mockFetchedItem(item);
    vi.mocked(repo.shouldSkipWork).mockResolvedValueOnce(false).mockResolvedValue(true);
    const mismatch = new AppError({
      domain: "github",
      kind: "head_sha_mismatch",
      message: "Pull request head SHA new does not match work item headSha old",
    });
    const execute = vi.fn().mockRejectedValue(mismatch);
    const onCancelled = vi.fn().mockResolvedValue(undefined);

    await runReviewWorkItem({ execute, onCancelled });

    expect(repo.markWorkCancelled).toHaveBeenCalledWith(pool, "wi-1", 1);
    expect(onCancelled).toHaveBeenCalledWith(
      expect.objectContaining({ id: "wi-1" }),
      expect.anything(),
      "skipped_after_error",
      1,
    );
    expect(repo.markWorkRetrying).not.toHaveBeenCalled();
    expect(repo.markWorkFailed).not.toHaveBeenCalled();
  });

  it("swallows lease-lost errors without terminalising", async () => {
    mockFetchedItem(makeItem());
    const boom = new AppError({
      domain: "agent_work",
      kind: "pr_actor_lease_lost",
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

  it("aborts the execution and PR-surface signals when renewal loses the lease", async () => {
    mockFetchedItem(makeItem({ status: "running" }));
    vi.mocked(prActorLease.renewPrActorLease).mockImplementation(async () => {
      vi.mocked(prActorLease.isPrActorLeaseHeld).mockResolvedValue(false);
      return false;
    });
    const execute = vi.fn(async (_item, env) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(env.signal.aborted).toBe(true);
      expect(vi.mocked(prSurface.createPrSurface).mock.calls[0]?.[0].mutationBoundary?.signal).toBe(
        env.signal,
      );
      return completedResult();
    });

    await runReviewWorkItem({
      cfg: { ...cfg, queue: { ...cfg.queue, prActorLeaseRenewalIntervalSeconds: 0.001 } },
      execute,
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(repo.markWorkCompleted).not.toHaveBeenCalled();
    expect(evlog.logInfo).toHaveBeenCalledWith(
      "agent_work_stale_execution_skipped",
      expect.objectContaining({ workItemId: "wi-1", leaseEpoch: 1 }),
    );
  });

  it("aborts the host signal when cancel is visible during execute", async () => {
    mockFetchedItem(makeItem({ status: "running" }));
    vi.mocked(repo.shouldSkipWork).mockResolvedValue(false);
    const execute = vi.fn(async (_item, env) => {
      vi.mocked(repo.shouldSkipWork).mockResolvedValue(true);
      await vi.waitFor(() => expect(env.signal.aborted).toBe(true));
      throw new AppError({
        domain: "agent",
        kind: "session_aborted",
        message: "Session aborted",
      });
    });

    await runReviewWorkItem({
      cfg: { ...cfg, queue: { ...cfg.queue, prActorLeaseRenewalIntervalSeconds: 120 } },
      execute,
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(repo.markWorkCancelled).toHaveBeenCalledWith(pool, "wi-1", 1);
    expect(repo.markWorkFailed).not.toHaveBeenCalled();
    expect(repo.markWorkRetrying).not.toHaveBeenCalled();
    expect(prActorLease.renewPrActorLease).not.toHaveBeenCalled();
  });

  it("aborts the host signal when the lease holder is cleared during execute", async () => {
    mockFetchedItem(makeItem({ status: "running" }));
    vi.mocked(prActorLease.isPrActorLeaseHeld).mockResolvedValue(true);
    const execute = vi.fn(async (_item, env) => {
      vi.mocked(prActorLease.isPrActorLeaseHeld).mockResolvedValue(false);
      await vi.waitFor(() => expect(env.signal.aborted).toBe(true));
      throw new AppError({
        domain: "agent",
        kind: "session_aborted",
        message: "Session aborted",
      });
    });

    await runReviewWorkItem({
      cfg: { ...cfg, queue: { ...cfg.queue, prActorLeaseRenewalIntervalSeconds: 120 } },
      execute,
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(repo.markWorkFailed).not.toHaveBeenCalled();
    expect(repo.markWorkRetrying).not.toHaveBeenCalled();
    expect(prActorLease.renewPrActorLease).not.toHaveBeenCalled();
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
      return {
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        startedAt: new Date("2026-01-01T00:00:05.000Z"),
        attemptCount: 1,
        resumed: false,
      };
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
      return {
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        startedAt: new Date("2026-01-01T00:00:05.000Z"),
        attemptCount: 1,
        resumed: false,
      };
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
    expect(repo.markWorkCancelled).toHaveBeenCalledWith(pool, "wi-1", null);
    expect(execute).not.toHaveBeenCalled();
  });

  it("retries acquire-and-claim once on a Postgres deadlock and owns the second epoch", async () => {
    const item = makeItem();
    mockFetchedItem(item);
    const deadlock = Object.assign(new Error("deadlock detected"), { code: "40P01" });
    vi.mocked(repo.claimWorkForExecution).mockRejectedValueOnce(deadlock);
    const execute = vi.fn().mockResolvedValue(completedResult());

    await runReviewWorkItem({ execute });

    expect(prActorLease.acquirePrActorLease).toHaveBeenCalledTimes(2);
    expect(repo.claimWorkForExecution).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(repo.markWorkCompleted).toHaveBeenCalledWith(pool, "wi-1", 1);
    // Failed attempt's in-tx cleanup plus the runner's final release.
    expect(prActorLease.releasePrActorLease).toHaveBeenCalledTimes(2);
  });

  it("does not retry acquire-and-claim twice on repeated deadlock", async () => {
    mockFetchedItem(makeItem());
    const deadlock = Object.assign(new Error("deadlock detected"), { code: "40P01" });
    vi.mocked(repo.claimWorkForExecution).mockRejectedValue(deadlock);
    const execute = vi.fn();

    await expect(runReviewWorkItem({ execute })).rejects.toBe(deadlock);

    expect(repo.claimWorkForExecution).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();
  });

  it("retries beginAttempt once on a Postgres deadlock but not on other errors", async () => {
    mockFetchedItem(makeItem());
    const deadlock = Object.assign(new Error("deadlock detected"), { code: "40P01" });
    const started = { kind: "started" as const, claim: mockWorkClaim() };
    vi.mocked(repo.beginWorkAttempt).mockReset();
    vi.mocked(repo.beginWorkAttempt).mockRejectedValueOnce(deadlock).mockResolvedValue(started);
    const execute = vi.fn().mockResolvedValue(completedResult());

    await runReviewWorkItem({ execute });

    expect(repo.beginWorkAttempt).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(1);

    vi.mocked(repo.beginWorkAttempt).mockReset();
    const other = new Error("connection reset");
    vi.mocked(repo.beginWorkAttempt).mockRejectedValue(other);
    await expect(runReviewWorkItem({ execute: vi.fn() })).rejects.toBe(other);
    expect(repo.beginWorkAttempt).toHaveBeenCalledTimes(1);
  });

  it("seeds the watchdog hop before acquire, then claims, marks terminal, and releases last", async () => {
    mockFetchedItem(makeItem());
    const boom = new Error("dead");
    const execute = vi.fn().mockRejectedValue(boom);

    await runReviewWorkItem({ job: makeJob(3, 3), execute });

    const order = [
      vi.mocked(boss.send).mock.invocationCallOrder[0],
      vi.mocked(prActorLease.acquirePrActorLease).mock.invocationCallOrder[0],
      vi.mocked(repo.claimWorkForExecution).mock.invocationCallOrder[0],
      vi.mocked(repo.markWorkFailed).mock.invocationCallOrder[0],
      vi.mocked(prActorLease.releasePrActorLease).mock.invocationCallOrder[0],
    ];
    expect(order.every((entry) => entry !== undefined)).toBe(true);
    expect(order.toSorted((a, b) => (a ?? 0) - (b ?? 0))).toEqual(order);
  });

  it("does not spend a durable retry on the watchdog seed or a lost-lease deferral", async () => {
    mockFetchedItem(makeItem());
    vi.mocked(prActorLease.acquirePrActorLease).mockResolvedValue({
      acquired: false,
      heldByWorkItemId: "wi-other",
      leaseEpoch: 7,
    });
    vi.mocked(boss.send).mockResolvedValue("seed-hop");

    await runReviewWorkItem({ execute: vi.fn() });

    expect(repo.beginWorkAttempt).not.toHaveBeenCalled();
    expect(repo.markWorkRetrying).not.toHaveBeenCalled();
    expect(repo.markWorkFailed).not.toHaveBeenCalled();
  });
});
