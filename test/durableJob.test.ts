import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Pool } from "pg";
import type { Config } from "../src/config.js";
import {
  clearDurableAuthCachesForTest,
  mintInstallationToken,
  runDurableWorkItem,
  type DurableJobSpec,
} from "../src/agentWork/durableJob.js";
import type { AgentWorkItem } from "../src/agentWork/types.js";

vi.mock("../src/agentWork/repository.js", () => ({
  getWorkItem: vi.fn(),
  getWorkItemCore: vi.fn(),
  getWorkItemPayload: vi.fn(),
  shouldSkipWork: vi.fn(),
  markWorkCancelled: vi.fn(),
  claimQueuedWorkItem: vi.fn(),
  claimWorkForExecution: vi.fn(),
  markWorkCompleted: vi.fn(),
  forceMarkRescheduledParentCompleted: vi.fn(),
  markWorkFailed: vi.fn(),
  markWorkPublishDegraded: vi.fn(),
  markWorkRetrying: vi.fn(),
  updateRunningWorkHeadSha: vi.fn(),
}));

vi.mock("../src/github/appAuth.js", () => ({
  mintInstallationAuth: vi.fn(),
  getAppBotIdentity: vi.fn(),
}));

import * as repo from "../src/agentWork/repository.js";
import * as appAuth from "../src/github/appAuth.js";

const cfg = {} as Config;
const pool = {} as Pool;
const boss = {} as PgBoss;

function makeItem(overrides: Partial<AgentWorkItem> = {}): AgentWorkItem {
  return {
    id: "wi-1",
    webhookEventId: "ev-1",
    type: "review",
    source: "auto",
    status: "queued",
    owner: "o",
    repo: "r",
    prNumber: 1,
    installationId: 42,
    headSha: "deadbeef",
    reviewLens: "review",
    resourceKey: "o/r#1",
    attemptCount: 0,
    payload: { mode: "review", source: "auto" },
    cancelRequestedAt: null,
    ...overrides,
  };
}

function coreOf(item: AgentWorkItem): Omit<AgentWorkItem, "payload"> {
  const { payload: _payload, ...core } = item;
  return core;
}

function mockFetchedItem(item: AgentWorkItem | null): void {
  vi.mocked(repo.getWorkItem).mockResolvedValue(item);
  vi.mocked(repo.getWorkItemCore).mockResolvedValue(item ? coreOf(item) : null);
  vi.mocked(repo.getWorkItemPayload).mockResolvedValue(item?.payload ?? null);
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
  } as unknown as JobWithMetadata<{ workItemId: string }>;
}

function runReviewWorkItem(
  overrides: Partial<DurableJobSpec> & Pick<DurableJobSpec, "execute">,
): Promise<void> {
  return runDurableWorkItem({
    cfg,
    pool,
    boss,
    job: makeJob(),
    type: "review",
    resolveHeadSha: async () => ({ headSha: "x" }),
    ...overrides,
  });
}

function defaultMocks() {
  vi.mocked(repo.getWorkItem).mockReset();
  vi.mocked(repo.getWorkItemCore).mockReset();
  vi.mocked(repo.getWorkItemPayload).mockReset();
  vi.mocked(repo.claimQueuedWorkItem).mockResolvedValue(null);
  vi.mocked(repo.shouldSkipWork).mockResolvedValue(false);
  vi.mocked(repo.claimWorkForExecution).mockResolvedValue(true);
  vi.mocked(repo.updateRunningWorkHeadSha).mockResolvedValue(true);
  vi.mocked(repo.markWorkCompleted).mockResolvedValue(true);
  vi.mocked(repo.markWorkFailed).mockResolvedValue(true);
  vi.mocked(repo.markWorkRetrying).mockResolvedValue(true);
  vi.mocked(repo.markWorkCancelled).mockResolvedValue();
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
    const execute = vi.fn().mockResolvedValue({});

    await runReviewWorkItem({ resolveHeadSha: async () => ({ headSha: "abc123" }), execute });

    expect(repo.claimWorkForExecution).toHaveBeenCalledWith(pool, "wi-1");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1].headSha).toBe("abc123");
    expect(execute.mock.calls[0]?.[1].installation.token).toBe("tok");
    expect(repo.markWorkCompleted).toHaveBeenCalledWith(pool, "wi-1");
    expect(repo.markWorkCancelled).not.toHaveBeenCalled();
    expect(repo.shouldSkipWork).toHaveBeenCalledTimes(2);
    expect(repo.markWorkPublishDegraded).not.toHaveBeenCalled();
  });

  it("fast path: one claimQueuedWorkItem call when acceptItem is omitted", async () => {
    const item = makeItem();
    vi.mocked(repo.claimQueuedWorkItem).mockResolvedValue(item);
    const execute = vi.fn().mockResolvedValue({});

    await runReviewWorkItem({ resolveHeadSha: async () => ({ headSha: "abc123" }), execute });

    expect(repo.claimQueuedWorkItem).toHaveBeenCalledTimes(1);
    expect(repo.claimQueuedWorkItem).toHaveBeenCalledWith(pool, "wi-1", "review");
    expect(repo.getWorkItemCore).not.toHaveBeenCalled();
    expect(repo.claimWorkForExecution).not.toHaveBeenCalled();
    expect(repo.getWorkItemPayload).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("uses legacy claim path when acceptItem is provided", async () => {
    const item = makeItem();
    mockFetchedItem(item);
    const execute = vi.fn().mockResolvedValue({});

    await runReviewWorkItem({
      acceptItem: (it) => it.reviewLens != null,
      execute,
    });

    expect(repo.claimQueuedWorkItem).not.toHaveBeenCalled();
    expect(repo.claimWorkForExecution).toHaveBeenCalledWith(pool, "wi-1");
    expect(execute).toHaveBeenCalledTimes(1);
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
    const execute = vi.fn().mockResolvedValue({});

    await runReviewWorkItem({
      resolveHeadSha: async () => ({ headSha: "abc123", pullRequest }),
      execute,
    });

    expect(repo.updateRunningWorkHeadSha).toHaveBeenCalledWith(pool, "wi-1", "abc123");
    expect(execute.mock.calls[0]?.[1].pullRequest).toBe(pullRequest);
  });

  it("returns without executing when payload is missing after claim", async () => {
    const item = makeItem();
    vi.mocked(repo.getWorkItemCore).mockResolvedValue(coreOf(item));
    vi.mocked(repo.getWorkItemPayload).mockResolvedValue(null);
    const execute = vi.fn();

    await runReviewWorkItem({ execute });

    expect(repo.claimWorkForExecution).toHaveBeenCalledWith(pool, "wi-1");
    expect(execute).not.toHaveBeenCalled();
    expect(repo.markWorkCompleted).not.toHaveBeenCalled();
  });

  it("returns without executing when item is null", async () => {
    mockFetchedItem(null);
    const execute = vi.fn();
    await runReviewWorkItem({ execute });
    expect(execute).not.toHaveBeenCalled();
    expect(repo.claimWorkForExecution).not.toHaveBeenCalled();
  });

  it("returns without executing when item type mismatches", async () => {
    mockFetchedItem(makeItem({ type: "ask" }));
    const execute = vi.fn();
    await runReviewWorkItem({ execute });
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns without executing when acceptItem rejects", async () => {
    mockFetchedItem(makeItem({ reviewLens: null }));
    const execute = vi.fn();
    await runReviewWorkItem({
      acceptItem: (it) => it.reviewLens != null,
      execute,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("cancels and returns before claim when shouldSkipWork is true", async () => {
    mockFetchedItem(makeItem());
    vi.mocked(repo.shouldSkipWork).mockResolvedValueOnce(true);
    const execute = vi.fn();

    await runReviewWorkItem({ execute });

    expect(repo.markWorkCancelled).toHaveBeenCalledWith(pool, "wi-1");
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
      expect.objectContaining({ token: "tok" }),
      "skipped_before_claim",
    );
  });

  it("returns without executing when claim fails", async () => {
    mockFetchedItem(makeItem());
    vi.mocked(repo.claimWorkForExecution).mockResolvedValue(false);
    const execute = vi.fn();

    await runReviewWorkItem({ execute });

    expect(execute).not.toHaveBeenCalled();
    expect(repo.markWorkCancelled).not.toHaveBeenCalled();
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
    expect(repo.markWorkCancelled).toHaveBeenCalledWith(pool, "wi-1");
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
    const execute = vi.fn().mockResolvedValue({});

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
    expect(repo.markWorkCancelled).toHaveBeenCalledWith(pool, "wi-1");
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
      expect.objectContaining({ token: "tok" }),
      "head_update_rejected",
    );
  });

  it("marks publish degraded when execute reports { degraded: true }", async () => {
    mockFetchedItem(makeItem());
    const execute = vi.fn().mockResolvedValue({ degraded: true });

    await runReviewWorkItem({ execute });

    expect(repo.markWorkPublishDegraded).toHaveBeenCalledWith(pool, "wi-1");
    expect(repo.markWorkCompleted).toHaveBeenCalled();
  });

  it("on non-terminal pg-boss attempt: marks retrying and rethrows", async () => {
    mockFetchedItem(makeItem());
    const boom = new Error("transient");
    const execute = vi.fn().mockRejectedValue(boom);

    await expect(runReviewWorkItem({ job: makeJob(0, 3), execute })).rejects.toBe(boom);

    expect(repo.markWorkRetrying).toHaveBeenCalledWith(pool, "wi-1", boom);
    expect(repo.markWorkFailed).not.toHaveBeenCalled();
  });

  it("on terminal pg-boss attempt: marks failed and invokes onTerminalFailure", async () => {
    mockFetchedItem(makeItem());
    const boom = new Error("dead");
    const execute = vi.fn().mockRejectedValue(boom);
    const onTerminalFailure = vi.fn().mockResolvedValue(undefined);

    await runReviewWorkItem({ job: makeJob(3, 3), execute, onTerminalFailure });

    expect(repo.markWorkFailed).toHaveBeenCalledWith(pool, "wi-1", boom);
    expect(onTerminalFailure).toHaveBeenCalledTimes(1);
    const [itemArg, installArg, errArg] = onTerminalFailure.mock.calls[0];
    expect(itemArg.id).toBe("wi-1");
    expect((installArg as { token: string }).token).toBe("tok");
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
          staleHeadReplacementWorkItemId: "replacement-wi",
        },
      }),
    );
    vi.mocked(repo.markWorkCompleted).mockResolvedValue(false);
    vi.mocked(repo.forceMarkRescheduledParentCompleted).mockResolvedValue(true);
    const afterComplete = vi.fn().mockResolvedValue(undefined);
    const execute = vi.fn().mockResolvedValue({
      rescheduled: true,
      replacementWorkItemId: "replacement-wi",
      afterComplete,
    });

    await runReviewWorkItem({ execute });

    expect(afterComplete).toHaveBeenCalledWith(boss, "job-1");
    expect(repo.forceMarkRescheduledParentCompleted).toHaveBeenCalledWith(pool, "wi-1");
    expect(repo.markWorkFailed).not.toHaveBeenCalled();
  });

  it("throws when rescheduled parent cannot be completed and replacement marker exists", async () => {
    mockFetchedItem(
      makeItem({
        status: "running",
        payload: {
          mode: "review",
          source: "slash",
          staleHeadReplacementWorkItemId: "replacement-wi",
        },
      }),
    );
    vi.mocked(repo.markWorkCompleted).mockResolvedValue(false);
    vi.mocked(repo.forceMarkRescheduledParentCompleted).mockResolvedValue(false);
    const execute = vi.fn().mockResolvedValue({
      rescheduled: true,
      replacementWorkItemId: "replacement-wi",
      afterComplete: vi.fn().mockResolvedValue(undefined),
    });

    await expect(runReviewWorkItem({ job: makeJob(0, 3), execute })).rejects.toThrow(
      /Failed to complete rescheduled parent/,
    );

    expect(repo.markWorkRetrying).toHaveBeenCalled();
  });
});
