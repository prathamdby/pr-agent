import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Pool } from "pg";
import type { Config } from "../src/config.js";
import { runDurableWorkItem } from "../src/agentWork/durableJob.js";
import type { AgentWorkItem } from "../src/agentWork/types.js";

vi.mock("../src/agentWork/repository.js", () => ({
  getWorkItem: vi.fn(),
  shouldSkipWork: vi.fn(),
  markWorkCancelled: vi.fn(),
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
  mintBotIdentity: vi.fn(),
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

function makeJob(retryCount = 0, retryLimit = 3): JobWithMetadata<{ workItemId: string }> {
  return {
    id: "job-1",
    data: { workItemId: "wi-1" },
    retryCount,
    retryLimit,
  } as unknown as JobWithMetadata<{ workItemId: string }>;
}

function defaultMocks() {
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
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    installationId: 42,
  } as Awaited<ReturnType<typeof appAuth.mintInstallationAuth>>);
  vi.mocked(appAuth.mintBotIdentity).mockResolvedValue({
    userId: 999,
    login: "pr-agent[bot]",
  } as Awaited<ReturnType<typeof appAuth.mintBotIdentity>>);
}

describe("runDurableWorkItem", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    defaultMocks();
  });

  it("happy path: claims, mints token, resolves head, executes, marks completed", async () => {
    const item = makeItem();
    vi.mocked(repo.getWorkItem).mockResolvedValue(item);
    const execute = vi.fn().mockResolvedValue({});

    await runDurableWorkItem({
      cfg,
      pool,
      boss,
      job: makeJob(),
      type: "review",
      resolveHeadSha: async () => "abc123",
      execute,
    });

    expect(repo.claimWorkForExecution).toHaveBeenCalledWith(pool, "wi-1");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1].headSha).toBe("abc123");
    expect(execute.mock.calls[0]?.[1].installation.token).toBe("tok");
    expect(repo.markWorkCompleted).toHaveBeenCalledWith(pool, "wi-1");
    expect(repo.markWorkCancelled).not.toHaveBeenCalled();
    expect(repo.markWorkPublishDegraded).not.toHaveBeenCalled();
  });

  it("returns without executing when item is null", async () => {
    vi.mocked(repo.getWorkItem).mockResolvedValue(null);
    const execute = vi.fn();
    await runDurableWorkItem({
      cfg,
      pool,
      boss,
      job: makeJob(),
      type: "review",
      resolveHeadSha: async () => "x",
      execute,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(repo.claimWorkForExecution).not.toHaveBeenCalled();
  });

  it("returns without executing when item type mismatches", async () => {
    vi.mocked(repo.getWorkItem).mockResolvedValue(makeItem({ type: "ask" }));
    const execute = vi.fn();
    await runDurableWorkItem({
      cfg,
      pool,
      boss,
      job: makeJob(),
      type: "review",
      resolveHeadSha: async () => "x",
      execute,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns without executing when acceptItem rejects", async () => {
    vi.mocked(repo.getWorkItem).mockResolvedValue(makeItem({ reviewLens: null }));
    const execute = vi.fn();
    await runDurableWorkItem({
      cfg,
      pool,
      boss,
      job: makeJob(),
      type: "review",
      acceptItem: (it) => it.reviewLens != null,
      resolveHeadSha: async () => "x",
      execute,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("cancels and returns before claim when shouldSkipWork is true", async () => {
    vi.mocked(repo.getWorkItem).mockResolvedValue(makeItem());
    vi.mocked(repo.shouldSkipWork).mockResolvedValueOnce(true);
    const execute = vi.fn();

    await runDurableWorkItem({
      cfg,
      pool,
      boss,
      job: makeJob(),
      type: "review",
      resolveHeadSha: async () => "x",
      execute,
    });

    expect(repo.markWorkCancelled).toHaveBeenCalledWith(pool, "wi-1");
    expect(repo.claimWorkForExecution).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns without executing when claim fails", async () => {
    vi.mocked(repo.getWorkItem).mockResolvedValue(makeItem());
    vi.mocked(repo.claimWorkForExecution).mockResolvedValue(false);
    const execute = vi.fn();

    await runDurableWorkItem({
      cfg,
      pool,
      boss,
      job: makeJob(),
      type: "review",
      resolveHeadSha: async () => "x",
      execute,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(repo.markWorkCancelled).not.toHaveBeenCalled();
  });

  it("cancels when payload.commenterId matches bot identity", async () => {
    vi.mocked(repo.getWorkItem).mockResolvedValue(
      makeItem({ payload: { mode: "review", source: "slash", commenterId: 999 } }),
    );
    const execute = vi.fn();

    await runDurableWorkItem({
      cfg,
      pool,
      boss,
      job: makeJob(),
      type: "review",
      resolveHeadSha: async () => "x",
      execute,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(repo.markWorkCancelled).toHaveBeenCalledWith(pool, "wi-1");
  });

  it("returns when updateRunningWorkHeadSha races and rejects the update", async () => {
    vi.mocked(repo.getWorkItem).mockResolvedValue(makeItem());
    vi.mocked(repo.updateRunningWorkHeadSha).mockResolvedValue(false);
    vi.mocked(repo.shouldSkipWork).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const execute = vi.fn();

    await runDurableWorkItem({
      cfg,
      pool,
      boss,
      job: makeJob(),
      type: "review",
      resolveHeadSha: async () => "x",
      execute,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(repo.markWorkCancelled).toHaveBeenCalledWith(pool, "wi-1");
    expect(repo.markWorkCompleted).not.toHaveBeenCalled();
  });

  it("marks publish degraded when execute reports { degraded: true }", async () => {
    vi.mocked(repo.getWorkItem).mockResolvedValue(makeItem());
    const execute = vi.fn().mockResolvedValue({ degraded: true });

    await runDurableWorkItem({
      cfg,
      pool,
      boss,
      job: makeJob(),
      type: "review",
      resolveHeadSha: async () => "x",
      execute,
    });

    expect(repo.markWorkPublishDegraded).toHaveBeenCalledWith(pool, "wi-1");
    expect(repo.markWorkCompleted).toHaveBeenCalled();
  });

  it("on non-terminal pg-boss attempt: marks retrying and rethrows", async () => {
    vi.mocked(repo.getWorkItem).mockResolvedValue(makeItem());
    const boom = new Error("transient");
    const execute = vi.fn().mockRejectedValue(boom);

    await expect(
      runDurableWorkItem({
        cfg,
        pool,
        job: makeJob(0, 3),
        type: "review",
        resolveHeadSha: async () => "x",
        execute,
      }),
    ).rejects.toBe(boom);

    expect(repo.markWorkRetrying).toHaveBeenCalledWith(pool, "wi-1", boom);
    expect(repo.markWorkFailed).not.toHaveBeenCalled();
  });

  it("on terminal pg-boss attempt: marks failed and invokes onTerminalFailure", async () => {
    vi.mocked(repo.getWorkItem).mockResolvedValue(makeItem());
    const boom = new Error("dead");
    const execute = vi.fn().mockRejectedValue(boom);
    const onTerminalFailure = vi.fn().mockResolvedValue(undefined);

    await runDurableWorkItem({
      cfg,
      pool,
      boss,
      job: makeJob(3, 3),
      type: "review",
      resolveHeadSha: async () => "x",
      execute,
      onTerminalFailure,
    });

    expect(repo.markWorkFailed).toHaveBeenCalledWith(pool, "wi-1", boom);
    expect(onTerminalFailure).toHaveBeenCalledTimes(1);
    const [itemArg, installArg, errArg] = onTerminalFailure.mock.calls[0];
    expect(itemArg.id).toBe("wi-1");
    expect((installArg as { token: string }).token).toBe("tok");
    expect(errArg).toBe(boom);
  });

  it("onTerminalFailure errors are caught (no rethrow)", async () => {
    vi.mocked(repo.getWorkItem).mockResolvedValue(makeItem());
    const execute = vi.fn().mockRejectedValue(new Error("dead"));
    const onTerminalFailure = vi.fn().mockRejectedValue(new Error("hook boom"));

    await expect(
      runDurableWorkItem({
        cfg,
        pool,
        job: makeJob(3, 3),
        type: "review",
        resolveHeadSha: async () => "x",
        execute,
        onTerminalFailure,
      }),
    ).resolves.toBeUndefined();
  });

  it("terminal failure with markWorkFailed=false skips onTerminalFailure", async () => {
    vi.mocked(repo.getWorkItem).mockResolvedValue(makeItem());
    vi.mocked(repo.markWorkFailed).mockResolvedValue(false);
    const execute = vi.fn().mockRejectedValue(new Error("dead"));
    const onTerminalFailure = vi.fn();

    await runDurableWorkItem({
      cfg,
      pool,
      boss,
      job: makeJob(3, 3),
      type: "review",
      resolveHeadSha: async () => "x",
      execute,
      onTerminalFailure,
    });

    expect(onTerminalFailure).not.toHaveBeenCalled();
  });

  it("completes rescheduled parent via force mark when markWorkCompleted races", async () => {
    vi.mocked(repo.getWorkItem).mockResolvedValue(
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

    await runDurableWorkItem({
      cfg,
      pool,
      boss,
      job: makeJob(),
      type: "review",
      resolveHeadSha: async () => "x",
      execute,
    });

    expect(afterComplete).toHaveBeenCalledWith(boss, "job-1");
    expect(repo.forceMarkRescheduledParentCompleted).toHaveBeenCalledWith(pool, "wi-1");
    expect(repo.markWorkFailed).not.toHaveBeenCalled();
  });

  it("throws when rescheduled parent cannot be completed and replacement marker exists", async () => {
    vi.mocked(repo.getWorkItem).mockResolvedValue(
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

    await expect(
      runDurableWorkItem({
        cfg,
        pool,
        boss,
        job: makeJob(0, 3),
        type: "review",
        resolveHeadSha: async () => "x",
        execute,
      }),
    ).rejects.toThrow(/Failed to complete rescheduled parent/);

    expect(repo.markWorkRetrying).toHaveBeenCalled();
  });
});
