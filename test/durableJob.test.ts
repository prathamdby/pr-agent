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
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Pool } from "pg";
import { AppError } from "../src/errors/appError.js";
import {
  createDurableRuntime,
  createDurableExecutionContext,
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
import * as evlog from "../src/evlog.js";
import { GITHUB_REACTION_MINUS_ONE, GITHUB_REACTION_PLUS_ONE } from "../src/settings/index.js";
import * as repositoryView from "../src/prWorkspace/prRepositoryView.js";
import { mockWorkClaim, fakeDurablePrSurface } from "./helpers/executorDurableHarness.js";

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

function completedResult(degradation?: readonly string[]): DurableExecutionResult {
  return degradation ? { kind: "completed", degradation } : { kind: "completed" };
}

function rescheduledResult(
  overrides: Partial<Omit<Extract<DurableExecutionResult, { kind: "rescheduled" }>, "kind">> = {},
): Extract<DurableExecutionResult, { kind: "rescheduled" }> {
  return {
    kind: "rescheduled",
    replacementWorkItemId: "replacement-wi",
    afterComplete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
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
  vi.mocked(repo.markWorkCancelled).mockResolvedValue(true);
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

    expect(repo.claimWorkForExecution).toHaveBeenCalledWith(pool, "wi-1", 1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1].headSha).toBe("abc123");
    expect(execute.mock.calls[0]?.[1].prSurface).toBeDefined();
    expect(execute.mock.calls[0]?.[1].claim).toEqual({
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      startedAt: new Date("2026-01-01T00:00:05.000Z"),
      attemptCount: 1,
      resumed: false,
    });
    expect(repo.markWorkCompleted).toHaveBeenCalledWith(pool, "wi-1", 1);
    expect(repo.markWorkCancelled).not.toHaveBeenCalled();
    expect(vi.mocked(repo.shouldSkipWork).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(repo.markWorkPublishDegraded).not.toHaveBeenCalled();
  });

  it("single-flights concurrent installation token mints", async () => {
    installationSurface = openInstallationSurface();
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

    const pending = Promise.all([
      installationSurface.token(cfg, 42),
      installationSurface.token(cfg, 42),
    ]);
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
    installationSurface = openInstallationSurface();
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

    const first = await installationSurface.token(cfg, 42);
    const second = await installationSurface.token(cfg, 42);

    expect(first.token).toBe("old-token");
    expect(second.token).toBe("new-token");
    expect(appAuth.mintInstallationAuth).toHaveBeenCalledTimes(2);
  });

  it("marks publish degraded when execute reports completed+degraded", async () => {
    mockFetchedItem(makeItem());
    const execute = vi.fn().mockResolvedValue(completedResult(["stale_head"]));

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
    vi.mocked(repo.shouldSkipWork).mockResolvedValueOnce(false).mockResolvedValue(true);
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

  it("retries a transient failure across the full pg-boss budget", async () => {
    const boom = new Error("transient");

    for (const retryCount of [0, 1, 2]) {
      mockFetchedItem(makeItem());
      const execute = vi.fn().mockRejectedValue(boom);
      await expect(runReviewWorkItem({ job: makeJob(retryCount, 3), execute })).rejects.toBe(boom);
    }

    expect(repo.markWorkRetrying).toHaveBeenCalledTimes(3);
    expect(repo.markWorkFailed).not.toHaveBeenCalled();
  });

  it("retries a deterministic failure exactly once and terminalises the second failure", async () => {
    const boom = new AppError({
      domain: "verification",
      kind: "missing_submit",
      message: "Verification run ended without submitVerification",
    });
    vi.mocked(repo.claimWorkForExecution)
      .mockResolvedValueOnce({
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        startedAt: new Date("2026-01-01T00:00:05.000Z"),
        attemptCount: 1,
        resumed: false,
      })
      .mockResolvedValueOnce({
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        startedAt: new Date("2026-01-01T00:00:05.000Z"),
        attemptCount: 2,
        resumed: false,
      });

    mockFetchedItem(makeItem());
    const execute = vi.fn().mockRejectedValue(boom);
    await expect(runReviewWorkItem({ job: makeJob(0, 3), execute })).rejects.toBe(boom);
    expect(repo.markWorkRetrying).toHaveBeenCalledWith(pool, "wi-1", boom, 1);
    expect(repo.markWorkFailed).not.toHaveBeenCalled();

    mockFetchedItem(makeItem());
    await runReviewWorkItem({ job: makeJob(1, 3), execute });
    expect(repo.markWorkRetrying).toHaveBeenCalledTimes(1);
    expect(repo.markWorkFailed).toHaveBeenCalledWith(pool, "wi-1", boom, 1);
  });

  it("terminalises a deterministic failure when the queue has no budget for its one retry", async () => {
    mockFetchedItem(makeItem());
    const boom = new AppError({
      domain: "triage",
      kind: "missing_submit",
      message: "Triage run ended without submitTriage",
    });
    const execute = vi.fn().mockRejectedValue(boom);

    await runReviewWorkItem({ job: makeJob(3, 3), execute });

    expect(repo.markWorkRetrying).not.toHaveBeenCalled();
    expect(repo.markWorkFailed).toHaveBeenCalledWith(pool, "wi-1", boom, 1);
  });

  it("carries escalation and a fresh lease epoch into the retry attempt", async () => {
    const item = makeItem();
    const escalationCfg = {
      ...cfg,
      models: { ...cfg.models, fallbackProvider: "anthropic", fallbackModel: "claude-sonnet-4" },
    };
    vi.mocked(prActorLease.acquirePrActorLease)
      .mockResolvedValueOnce({ acquired: true, leaseEpoch: 1 })
      .mockResolvedValueOnce({ acquired: true, leaseEpoch: 2 });
    vi.mocked(repo.claimWorkForExecution)
      .mockResolvedValueOnce({
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        startedAt: new Date("2026-01-01T00:00:05.000Z"),
        attemptCount: 1,
        resumed: false,
      })
      .mockResolvedValueOnce({
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        startedAt: new Date("2026-01-01T00:00:05.000Z"),
        attemptCount: 2,
        resumed: false,
      });
    const execute = vi.fn().mockResolvedValue(completedResult());

    mockFetchedItem(item);
    await runReviewWorkItem({ cfg: escalationCfg, execute });
    mockFetchedItem(item);
    await runReviewWorkItem({ cfg: escalationCfg, execute });

    expect(execute.mock.calls[0]?.[1].escalation).toBeUndefined();
    expect(execute.mock.calls[1]?.[1].escalation).toEqual({
      attempt: 2,
      kinds: ["tool_rounds", "fallback_model"],
      model: { provider: "anthropic", model: "claude-sonnet-4" },
    });
    expect(execute.mock.calls[0]?.[1].leaseEpoch).toBe(1);
    expect(execute.mock.calls[1]?.[1].leaseEpoch).toBe(2);
    expect(prActorLease.releasePrActorLease).toHaveBeenNthCalledWith(1, pool, {
      resourceKey: item.resourceKey,
      workType: "review",
      leaseEpoch: 1,
    });
    expect(prActorLease.releasePrActorLease).toHaveBeenNthCalledWith(2, pool, {
      resourceKey: item.resourceKey,
      workType: "review",
      leaseEpoch: 2,
    });
  });

  it("terminalises fresh work at the budget gate after recovery preparation", async () => {
    mockFetchedItem(makeItem());
    vi.mocked(repo.claimWorkForExecution).mockResolvedValue({
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      startedAt: new Date("2026-01-01T00:00:05.000Z"),
      attemptCount: cfg.queue.retryLimit + 2,
      resumed: true,
    });
    const onTerminalFailure = vi.fn().mockResolvedValue(undefined);
    const execute = vi.fn();

    await runReviewWorkItem({ job: makeJob(0, 3), execute, onTerminalFailure });

    expect(execute).not.toHaveBeenCalled();
    expect(repo.updateRunningWorkHeadSha).toHaveBeenCalled();
    expect(repo.markWorkRetrying).not.toHaveBeenCalled();
    expect(repo.markWorkFailed).toHaveBeenCalledWith(
      pool,
      "wi-1",
      expect.objectContaining({ code: "agent_work.attempts_exhausted" }),
      1,
    );
    expect(onTerminalFailure).toHaveBeenCalledWith(
      expect.objectContaining({ id: "wi-1" }),
      expect.anything(),
      expect.objectContaining({ code: "agent_work.attempts_exhausted" }),
      1,
    );
    expect(evlog.logInfo).toHaveBeenCalledWith(
      "agent_work_resumed",
      expect.objectContaining({
        type: "review",
        workItemId: "wi-1",
        attemptCount: cfg.queue.retryLimit + 2,
      }),
    );
  });

  it("stops retrying a transient failure once the durable attempt budget is spent", async () => {
    mockFetchedItem(makeItem());
    vi.mocked(repo.claimWorkForExecution).mockResolvedValue({
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      startedAt: new Date("2026-01-01T00:00:05.000Z"),
      attemptCount: cfg.queue.retryLimit + 1,
      resumed: true,
    });
    const boom = new Error("transient");
    const execute = vi.fn().mockRejectedValue(boom);

    await runReviewWorkItem({ job: makeJob(0, 3), execute });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(repo.markWorkRetrying).not.toHaveBeenCalled();
    expect(repo.markWorkFailed).toHaveBeenCalledWith(pool, "wi-1", boom, 1);
  });

  it("terminal-fails stale-head replacement exhaustion without durable retry", async () => {
    mockFetchedItem(makeItem());
    const boom = new AppError({
      domain: "review",
      kind: "stale_head_replacement_exhausted",
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
      1,
    );
    expect(evlog.logError).toHaveBeenCalledWith(
      "agent_work_failed",
      expect.objectContaining({ workItemId: "wi-1", retryDisposition: "terminal" }),
      boom,
    );
  });

  it("passes the resolved head to onTerminalFailure after a deferred-head resolve", async () => {
    mockFetchedItem(makeItem({ headSha: DEFERRED_HEAD_SHA }));
    const boom = new Error("dead");
    const execute = vi.fn().mockRejectedValue(boom);
    const onTerminalFailure = vi.fn().mockResolvedValue(undefined);

    await runReviewWorkItem({
      job: makeJob(3, 3),
      resolveHeadSha: async () => ({ headSha: "resolved-head" }),
      execute,
      onTerminalFailure,
    });

    expect(onTerminalFailure).toHaveBeenCalledTimes(1);
    expect(onTerminalFailure.mock.calls[0]?.[0]).toMatchObject({
      id: "wi-1",
      headSha: "resolved-head",
    });
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
    const failOrder = vi.mocked(repo.markWorkFailed).mock.invocationCallOrder[0];
    const hookOrder = onTerminalFailure.mock.invocationCallOrder[0];
    const releaseOrder = vi.mocked(prActorLease.releasePrActorLease).mock.invocationCallOrder[0];
    expect(failOrder).toBeDefined();
    expect(hookOrder).toBeDefined();
    expect(releaseOrder).toBeDefined();
    expect(failOrder).toBeLessThan(hookOrder ?? 0);
    expect(hookOrder).toBeLessThan(releaseOrder ?? 0);
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

  it("does not complete a rescheduled parent without a lease epoch", async () => {
    mockFetchedItem(makeItem({ status: "running" }));
    const afterComplete = vi.fn().mockResolvedValue(undefined);
    const execute = vi.fn().mockResolvedValue(rescheduledResult({ afterComplete }));

    await runDurableWorkItem({
      contextPolicy: createWorkDefinitions({ cfg, pool, boss }).review.contextPolicy,
      cfg,
      runtime: createDurableRuntime({ installationSurface }),
      pool,
      boss,
      job: makeJob(),
      type: "review",
      resolveHeadSha: async () => ({ headSha: "x" }),
      execute,
    });

    expect(afterComplete).not.toHaveBeenCalled();
    expect(repo.forceMarkRescheduledParentCompleted).not.toHaveBeenCalled();
    expect(evlog.logInfo).toHaveBeenCalledWith(
      "agent_work_stale_execution_skipped",
      expect.objectContaining({ workItemId: "wi-1", leaseEpoch: null }),
    );
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
    expect(repo.forceMarkRescheduledParentCompleted).toHaveBeenCalledWith(pool, "wi-1", 1);
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
    vi.mocked(repo.shouldSkipWork).mockResolvedValue(false);
    vi.mocked(repo.markWorkCompleted).mockResolvedValue(false);
    vi.mocked(repo.forceMarkRescheduledParentCompleted).mockResolvedValue(false);
    const afterComplete = vi.fn().mockResolvedValue(undefined);
    const execute = vi.fn(async () => {
      vi.mocked(repo.shouldSkipWork).mockResolvedValue(true);
      return rescheduledResult({ afterComplete });
    });

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
    const onTerminalFailure = vi.fn().mockResolvedValue(undefined);
    const execute = vi
      .fn()
      .mockResolvedValue(rescheduledResult({ afterComplete: vi.fn().mockRejectedValue(boom) }));

    await expect(
      runReviewWorkItem({ job: makeJob(0, 3), execute, onTerminalFailure }),
    ).rejects.toBe(boom);

    expect(repo.markWorkRetrying).toHaveBeenCalledWith(pool, "wi-1", boom, 1);
    expect(onTerminalFailure).not.toHaveBeenCalled();
    expect(repo.markWorkFailed).not.toHaveBeenCalled();
  });

  it("hands the terminal afterComplete failure to the feature terminal hook", async () => {
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
    const execute = vi
      .fn()
      .mockResolvedValue(rescheduledResult({ afterComplete: vi.fn().mockRejectedValue(boom) }));

    await runReviewWorkItem({ job: makeJob(3, 3), execute, onTerminalFailure });

    expect(repo.markWorkFailed).toHaveBeenCalledWith(pool, "wi-1", boom, 1);
    expect(onTerminalFailure).toHaveBeenCalledTimes(1);
    expect(onTerminalFailure).toHaveBeenCalledWith(
      expect.objectContaining({ id: "wi-1" }),
      expect.anything(),
      boom,
      1,
    );
    expect(repo.markWorkRetrying).not.toHaveBeenCalled();
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
    const onTerminalFailure = vi.fn();
    const execute = vi.fn().mockResolvedValue(rescheduledResult({ afterComplete }));

    await expect(
      runReviewWorkItem({ job: makeJob(0, 3), execute, onTerminalFailure }),
    ).rejects.toBe(boom);
    expect(onTerminalFailure).not.toHaveBeenCalled();
    expect(repo.markWorkRetrying).toHaveBeenCalledWith(pool, "wi-1", boom, 1);

    await runReviewWorkItem({ job: makeJob(1, 3), execute, onTerminalFailure });

    expect(afterComplete).toHaveBeenCalledTimes(2);
    expect(repo.markWorkCompleted).toHaveBeenCalledWith(pool, "wi-1", 1);
    expect(onTerminalFailure).not.toHaveBeenCalled();
  });
});

describe("durable execution context policies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    defaultMocks();
    vi.restoreAllMocks();
  });

  it("admits concurrent repository views once before acquisition and supplies bound metadata", async () => {
    const item = makeItem();
    let admit!: () => void;
    const beginAttempt = vi.fn(
      () =>
        new Promise<ReturnType<typeof mockWorkClaim>>((resolve) => {
          admit = () => resolve(mockWorkClaim());
        }),
    );
    const acquire = vi
      .spyOn(repositoryView, "withPrRepositoryView")
      .mockResolvedValue("view-result");
    const surface = fakeDurablePrSurface();
    const env = createDurableExecutionContext({
      pool,
      item,
      job: makeJob(),
      prSurface: surface,
      headSha: "bound-head",
      leaseEpoch: 1,
      signal: new AbortController().signal,
      beginAttempt,
      getClaim: () => undefined,
      getEscalation: () => undefined,
    });
    const callback = vi.fn();
    const first = env.withAdmittedRepositoryView({ repositorySizeKb: 42 }, callback);
    const second = env.withAdmittedRepositoryView({}, callback);
    expect(beginAttempt).toHaveBeenCalledOnce();
    expect(acquire).not.toHaveBeenCalled();
    admit();
    await expect(first).resolves.toBe("view-result");
    await expect(second).resolves.toBe("view-result");
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(acquire.mock.calls[0]?.[0]).toMatchObject({
      owner: item.owner,
      repo: item.repo,
      prNumber: item.prNumber,
      headSha: "bound-head",
      repositorySizeKb: 42,
    });
    await expect(acquire.mock.calls[0]?.[0].gitCredentialAuth()).resolves.toMatchObject({
      token: "tok",
    });
    expect(env.durability).toEqual({
      pool,
      workItemId: item.id,
      installationId: item.installationId,
      owner: item.owner,
      repo: item.repo,
      prNumber: item.prNumber,
      executionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      attemptCount: undefined,
    });
  });

  it("never prepares a view after rejected admission, including later requests", async () => {
    const failure = new Error("admission rejected");
    const beginAttempt = vi.fn().mockRejectedValue(failure);
    const acquire = vi.spyOn(repositoryView, "withPrRepositoryView");
    const env = createDurableExecutionContext({
      pool,
      item: makeItem(),
      job: makeJob(),
      prSurface: fakeDurablePrSurface(),
      headSha: "head",
      leaseEpoch: 1,
      signal: new AbortController().signal,
      beginAttempt,
      getClaim: () => undefined,
      getEscalation: () => undefined,
    });
    const callback = vi.fn();
    await expect(env.withAdmittedRepositoryView({}, callback)).rejects.toBe(failure);
    await expect(env.withAdmittedRepositoryView({}, callback)).rejects.toBe(failure);
    expect(beginAttempt).toHaveBeenCalledOnce();
    expect(acquire).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });

  it("checks signal then cancellation then lease, and propagates failed reads", async () => {
    const controller = new AbortController();
    const item = makeItem();
    const env = createDurableExecutionContext({
      pool,
      item,
      job: makeJob(),
      prSurface: fakeDurablePrSurface(),
      headSha: "head",
      leaseEpoch: 7,
      signal: controller.signal,
      beginAttempt: async () => mockWorkClaim(),
      getClaim: () => undefined,
      getEscalation: () => undefined,
    });
    vi.mocked(repo.shouldSkipWork).mockImplementation(async () => {
      expect(prActorLease.isPrActorLeaseHeld).not.toHaveBeenCalled();
      return false;
    });
    await expect(env.shouldAbortPublish()).resolves.toBe(false);
    expect(prActorLease.isPrActorLeaseHeld).toHaveBeenCalledWith(pool, item.id, 7);
    vi.mocked(prActorLease.isPrActorLeaseHeld).mockClear().mockResolvedValue(false);
    vi.mocked(repo.shouldSkipWork).mockResolvedValue(false);
    await expect(env.shouldAbortPublish()).resolves.toBe(true);
    vi.mocked(prActorLease.isPrActorLeaseHeld).mockClear();
    vi.mocked(repo.shouldSkipWork).mockResolvedValue(true);
    await expect(env.shouldAbortPublish()).resolves.toBe(true);
    expect(prActorLease.isPrActorLeaseHeld).not.toHaveBeenCalled();
    const failure = new Error("cancellation read failed");
    vi.mocked(repo.shouldSkipWork).mockRejectedValue(failure);
    await expect(env.shouldAbortPublish()).rejects.toBe(failure);
    vi.mocked(repo.shouldSkipWork).mockResolvedValue(false);
    vi.mocked(prActorLease.isPrActorLeaseHeld).mockRejectedValue(failure);
    await expect(env.shouldAbortPublish()).rejects.toBe(failure);
    vi.mocked(repo.shouldSkipWork).mockClear();
    controller.abort();
    await expect(env.shouldAbortPublish()).resolves.toBe(true);
    expect(repo.shouldSkipWork).not.toHaveBeenCalled();
  });

  it("does not query a lease for unleased work", async () => {
    const env = createDurableExecutionContext({
      pool,
      item: makeAskWorkItem(),
      job: makeJob(),
      prSurface: fakeDurablePrSurface(),
      headSha: "head",
      leaseEpoch: null,
      signal: new AbortController().signal,
      beginAttempt: async () => mockWorkClaim(),
      getClaim: () => undefined,
      getEscalation: () => undefined,
    });
    await expect(env.shouldAbortPublish()).resolves.toBe(false);
    expect(repo.shouldSkipWork).toHaveBeenCalledOnce();
    expect(prActorLease.isPrActorLeaseHeld).not.toHaveBeenCalled();
  });
});

describe("DurableExecutionResult assignability", () => {
  it("accepts completed, completed-degraded, and fully specified rescheduled", () => {
    expectTypeOf({ kind: "completed" as const }).toMatchTypeOf<DurableExecutionResult>();
    expectTypeOf({
      kind: "completed" as const,
      degradation: ["stale_head"] as const,
    }).toMatchTypeOf<DurableExecutionResult>();
    expectTypeOf({
      kind: "rescheduled" as const,
      replacementWorkItemId: "replacement-wi",
      afterComplete: async (_boss: PgBoss) => undefined,
    }).toMatchTypeOf<DurableExecutionResult>();
  });

  it("rejects incomplete reschedule and the old optional-flag shapes", () => {
    expectTypeOf<{ kind: "rescheduled" }>().not.toMatchTypeOf<DurableExecutionResult>();
    expectTypeOf<{ degraded: true }>().not.toMatchTypeOf<DurableExecutionResult>();
    expectTypeOf<{
      rescheduled: true;
      replacementWorkItemId: string;
      afterComplete: (boss: PgBoss) => Promise<void>;
    }>().not.toMatchTypeOf<DurableExecutionResult>();
  });

  it("constructs valid object literals", () => {
    const accept = (result: DurableExecutionResult): DurableExecutionResult => result;
    accept({ kind: "completed" });
    accept({ kind: "completed", degradation: ["push_stale", "bulk_partial"] });
    accept({
      kind: "rescheduled",
      replacementWorkItemId: "replacement-wi",
      afterComplete: async () => undefined,
    });
  });
});
