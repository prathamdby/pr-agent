import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { PgBoss } from "pg-boss";
import type { JobWithMetadata } from "pg-boss";
import type { DurableJobSpec } from "../src/agentWork/durableJob.js";
import type { AskJobData } from "../src/agentWork/types.js";
import { askReplyOperationKey } from "../src/agentWork/withOperationIntent.js";
import { makeTestConfig } from "./helpers/config.js";
import {
  durablePrSurfaceControls,
  fakeDurablePrSurface,
  makeDurableJobMetadata,
  resetDurablePrSurface,
} from "./helpers/executorDurableHarness.js";
import { makeAskWorkItem } from "./helpers/agentWorkItems.js";
import { mockLocalPrWorkspace } from "./helpers/mockWorkspace.js";
import { memoryOperationIntentStore } from "./setup/operationIntent-memory.js";
import { resetCreatePrSurface, setCreatePrSurface } from "../src/github/prSurface.js";
import { executeAskJob } from "../src/agentWork/executors/askExecutor.js";
import * as workItemState from "../src/agentWork/workItemStateRepository.js";
import { assertCurrentExecutionEpoch } from "../src/agentWork/workItemStateRepository.js";
import { AppError } from "../src/errors/appError.js";
import * as repo from "../src/agentWork/repository.js";
import * as askRun from "../src/agent/ask/askRun.js";
import * as durableJob from "../src/agentWork/durableJob.js";
import * as prWorkspace from "../src/prWorkspace/index.js";
import * as appAuth from "../src/github/appAuth.js";
import * as recoverAskReply from "../src/agent/ask/recoverAskReply.js";
import * as evlog from "../src/evlog.js";
import type { PrRepositoryView } from "../src/prWorkspace/prRepositoryView.js";

const cfg = makeTestConfig({ piModel: "test" });
const pool = new Pool({ connectionString: "postgres://127.0.0.1:1/unused" });
const boss = new PgBoss({ connectionString: "postgres://127.0.0.1:1/unused" });

const emptyPreflight = {
  files: [] as const,
  truncated: false,
  fileCount: 0,
  totalChanges: 0,
};

function repositoryView(): PrRepositoryView {
  return {
    agentCwd: "/tmp/pr-agent",
    workspace: mockLocalPrWorkspace(),
    preflight: emptyPreflight,
  };
}

function askItem() {
  return makeAskWorkItem({ headSha: "head" });
}

function askJob(): JobWithMetadata<AskJobData> {
  return {
    ...makeDurableJobMetadata(),
    name: "agent-work-ask",
    data: { kind: "ask", workItemId: "wi-1" },
  };
}

function mockDurableExecution(): void {
  vi.mocked(durableJob.runDurableWorkItem).mockImplementation(async (spec) => {
    if (spec.type !== "ask") return;
    await spec.execute(askItem(), {
      prSurface: fakeDurablePrSurface(),
      headSha: "head",
      executionEpoch: 1,
      signal: new AbortController().signal,
    });
  });
}

function mockRepositoryView(): void {
  vi.mocked(prWorkspace.withPrRepositoryView).mockImplementation(async (_params, run) =>
    run(repositoryView()),
  );
}

describe("executeAskJob", () => {
  beforeEach(() => {
    resetDurablePrSurface();
    setCreatePrSurface(() => fakeDurablePrSurface());
    vi.spyOn(repo, "hasCompletedPublishStep").mockResolvedValue(false);
    vi.spyOn(repo, "recordAskPublishStep").mockResolvedValue(undefined);
    vi.spyOn(workItemState, "assertCurrentExecutionEpoch").mockResolvedValue(undefined);
    vi.spyOn(workItemState, "isExecutionEpochCurrent").mockResolvedValue(true);
    vi.spyOn(askRun, "runAskRun").mockResolvedValue({ answer: "answer", replied: false });
    vi.spyOn(durableJob, "runDurableWorkItem");
    vi.spyOn(prWorkspace, "withPrRepositoryView");
    vi.spyOn(appAuth, "getAppBotIdentity").mockResolvedValue({
      userId: 1,
      login: "pr-agent[bot]",
    });
    vi.spyOn(recoverAskReply, "findExistingAskReplyComment").mockResolvedValue(null);
    vi.spyOn(evlog, "logWarn").mockImplementation(() => undefined);
    mockDurableExecution();
    mockRepositoryView();
  });

  afterEach(() => {
    resetCreatePrSurface();
    vi.restoreAllMocks();
  });

  it("runs the agent and records first answer publish", async () => {
    await executeAskJob(cfg, pool, boss, askJob());

    expect(askRun.runAskRun).toHaveBeenCalledTimes(1);
    expect(durablePrSurfaceControls().replies).toHaveLength(1);
    expect(durablePrSurfaceControls().replies[0]?.body).toBe("answer");
    expect(repo.recordAskPublishStep).toHaveBeenCalledTimes(1);
    expect(repo.recordAskPublishStep).toHaveBeenCalledWith(pool, {
      workItemId: "wi-1",
      resourceKey: "o/r#1",
      step: "ask_reply",
      detail: {
        replyTargetKind: "prConversation",
        commentId: expect.any(Number),
      },
      executionEpoch: 1,
    });
    const intent = memoryOperationIntentStore.get("wi-1", askReplyOperationKey("o/r#1"));
    expect(intent?.status).toBe("reconciled");
    expect(intent?.detail.__result).toEqual({
      commentId: expect.any(Number),
    });
  });

  it("skips agent and answer publish when the ask reply was already recorded", async () => {
    vi.mocked(repo.hasCompletedPublishStep).mockResolvedValue(true);

    await executeAskJob(cfg, pool, boss, askJob());

    expect(prWorkspace.withPrRepositoryView).not.toHaveBeenCalled();
    expect(askRun.runAskRun).not.toHaveBeenCalled();
    expect(durablePrSurfaceControls().replies).toHaveLength(0);
    expect(repo.recordAskPublishStep).not.toHaveBeenCalled();
  });

  it("returns degraded when the publish record fails after answer delivery", async () => {
    let result: Awaited<ReturnType<DurableJobSpec<"ask">["execute"]>> | undefined;
    vi.mocked(repo.recordAskPublishStep).mockRejectedValue(new Error("record failed"));
    vi.mocked(durableJob.runDurableWorkItem).mockImplementation(async (spec) => {
      if (spec.type !== "ask") return;
      result = await spec.execute(askItem(), {
        prSurface: fakeDurablePrSurface(),
        headSha: "head",
        executionEpoch: 1,
        signal: new AbortController().signal,
      });
    });

    await executeAskJob(cfg, pool, boss, askJob());

    expect(result).toEqual({ degraded: true });
    expect(askRun.runAskRun).toHaveBeenCalledTimes(1);
    expect(durablePrSurfaceControls().replies).toHaveLength(1);
    expect(repo.recordAskPublishStep).toHaveBeenCalledTimes(1);
  });

  it("skips terminal failure reply after the answer was delivered", async () => {
    vi.mocked(repo.recordAskPublishStep).mockRejectedValue(new Error("record failed"));
    vi.mocked(durableJob.runDurableWorkItem).mockImplementation(async (spec) => {
      if (spec.type !== "ask") return;
      const item = askItem();
      const prSurface = fakeDurablePrSurface();
      await spec.execute(item, {
        prSurface,
        headSha: "head",
        executionEpoch: 1,
        signal: new AbortController().signal,
      });
      await spec.onTerminalFailure?.(item, prSurface, new Error("complete failed"));
    });

    await executeAskJob(cfg, pool, boss, askJob());

    expect(durablePrSurfaceControls().replies).toHaveLength(1);
    expect(durablePrSurfaceControls().replies[0]?.body).toBe("answer");
  });

  it("skips terminal failure reply when durable ask_reply is already published", async () => {
    vi.mocked(repo.hasCompletedPublishStep).mockResolvedValue(true);
    vi.mocked(durableJob.runDurableWorkItem).mockImplementation(async (spec) => {
      if (spec.type !== "ask") return;
      const item = askItem();
      const prSurface = fakeDurablePrSurface();
      await spec.onTerminalFailure?.(item, prSurface, new Error("dead"));
    });

    await executeAskJob(cfg, pool, boss, askJob());

    expect(durablePrSurfaceControls().replies).toHaveLength(0);
  });

  it("falls back to a PR comment when inline thread reply fails", async () => {
    const item = makeAskWorkItem({
      headSha: "head",
      payload: {
        question: "why this line?",
        replyTarget: {
          kind: "inlineReviewThread",
          prNumber: 1,
          inReplyToCommentId: 55,
        },
        commentId: 99,
      },
    });
    durablePrSurfaceControls().rejectNextInlineReviewReply(new Error("thread unavailable"));
    vi.mocked(durableJob.runDurableWorkItem).mockImplementation(async (spec) => {
      if (spec.type !== "ask") return;
      await spec.execute(item, {
        prSurface: fakeDurablePrSurface(),
        headSha: "head",
        executionEpoch: 1,
        signal: new AbortController().signal,
      });
    });

    await executeAskJob(cfg, pool, boss, askJob());

    expect(durablePrSurfaceControls().replies).toHaveLength(1);
    expect(durablePrSurfaceControls().replies[0]?.target).toEqual({
      kind: "prConversation",
      prNumber: 1,
    });
    expect(durablePrSurfaceControls().replies[0]?.body).toContain(
      "Could not reply in the review thread",
    );
    expect(durablePrSurfaceControls().replies[0]?.body).toContain("answer");
    expect(repo.recordAskPublishStep).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        detail: expect.objectContaining({ commentId: expect.any(Number) }),
      }),
    );
  });

  it("posts terminal failure reply when the ask never delivered an answer", async () => {
    vi.mocked(askRun.runAskRun).mockRejectedValue(new Error("agent failed"));
    vi.mocked(durableJob.runDurableWorkItem).mockImplementation(async (spec) => {
      if (spec.type !== "ask") return;
      const item = askItem();
      const prSurface = fakeDurablePrSurface();
      await expect(
        spec.execute(item, {
          prSurface,
          headSha: "head",
          executionEpoch: 1,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("agent failed");
      await spec.onTerminalFailure?.(item, prSurface, new Error("dead"));
    });

    await executeAskJob(cfg, pool, boss, askJob());

    expect(durablePrSurfaceControls().replies).toHaveLength(1);
    expect(durablePrSurfaceControls().replies[0]?.body).toContain(
      "could not complete this ask after retries",
    );
    expect(durablePrSurfaceControls().replies[0]?.body).toContain("**Question:** what changed?");
  });

  it("does not post terminal failure reply on non-terminal retry", async () => {
    vi.mocked(askRun.runAskRun).mockRejectedValue(new Error("transient"));
    vi.mocked(durableJob.runDurableWorkItem).mockImplementation(async (spec) => {
      if (spec.type !== "ask") return;
      const item = askItem();
      const prSurface = fakeDurablePrSurface();
      await expect(
        spec.execute(item, {
          prSurface,
          headSha: "head",
          executionEpoch: 1,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("transient");
    });

    await executeAskJob(cfg, pool, boss, askJob());

    expect(durablePrSurfaceControls().replies).toHaveLength(0);
  });

  it("does not remutate or rerun the model after post-mutate / pre-reconcile crash", async () => {
    memoryOperationIntentStore.failNextReconcile(new Error("crash before reconcile"), 1);

    await expect(executeAskJob(cfg, pool, boss, askJob())).rejects.toThrow(
      "crash before reconcile",
    );

    expect(askRun.runAskRun).toHaveBeenCalledTimes(1);
    expect(durablePrSurfaceControls().replies).toHaveLength(1);
    const operationKey = askReplyOperationKey("o/r#1");
    const pending = memoryOperationIntentStore.get("wi-1", operationKey);
    expect(pending?.status).toBe("pending");
    expect(pending?.detail.__result).toEqual({ commentId: expect.any(Number) });
    expect(repo.recordAskPublishStep).not.toHaveBeenCalled();

    vi.mocked(askRun.runAskRun).mockClear();
    vi.mocked(recoverAskReply.findExistingAskReplyComment).mockClear();
    resetDurablePrSurface();
    setCreatePrSurface(() => fakeDurablePrSurface());

    await executeAskJob(cfg, pool, boss, askJob());

    expect(askRun.runAskRun).not.toHaveBeenCalled();
    expect(durablePrSurfaceControls().replies).toHaveLength(0);
    expect(recoverAskReply.findExistingAskReplyComment).not.toHaveBeenCalled();
    expect(repo.recordAskPublishStep).toHaveBeenCalledTimes(1);
    expect(memoryOperationIntentStore.get("wi-1", operationKey)?.status).toBe("reconciled");
  });

  it("recovers from a remote ask reply when intent is pending without __result", async () => {
    await memoryOperationIntentStore.persist(pool, {
      workItemId: "wi-1",
      operationKey: askReplyOperationKey("o/r#1"),
      mutationKind: "github.ask_reply",
      detail: { step: "ask_reply" },
    });
    vi.mocked(recoverAskReply.findExistingAskReplyComment).mockResolvedValue({ commentId: 4242 });

    await executeAskJob(cfg, pool, boss, askJob());

    expect(askRun.runAskRun).not.toHaveBeenCalled();
    expect(durablePrSurfaceControls().replies).toHaveLength(0);
    expect(recoverAskReply.findExistingAskReplyComment).toHaveBeenCalledTimes(1);
    expect(repo.recordAskPublishStep).toHaveBeenCalledWith(pool, {
      workItemId: "wi-1",
      resourceKey: "o/r#1",
      step: "ask_reply",
      detail: { replyTargetKind: "prConversation", commentId: 4242 },
      executionEpoch: 1,
    });
    expect(memoryOperationIntentStore.get("wi-1", askReplyOperationKey("o/r#1"))?.status).toBe(
      "reconciled",
    );
  });

  it("recovers a remote ask reply when intent is outcome_unknown without __result", async () => {
    const operationKey = askReplyOperationKey("o/r#1");
    await memoryOperationIntentStore.persist(pool, {
      workItemId: "wi-1",
      operationKey,
      mutationKind: "github.ask_reply",
      detail: { step: "ask_reply" },
    });
    await memoryOperationIntentStore.reconcile(pool, {
      workItemId: "wi-1",
      operationKey,
      status: "outcome_unknown",
    });
    vi.mocked(recoverAskReply.findExistingAskReplyComment).mockResolvedValue({ commentId: 5151 });

    await executeAskJob(cfg, pool, boss, askJob());

    expect(askRun.runAskRun).not.toHaveBeenCalled();
    expect(durablePrSurfaceControls().replies).toHaveLength(0);
    expect(repo.recordAskPublishStep).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        detail: expect.objectContaining({ commentId: 5151 }),
      }),
    );
    const intent = memoryOperationIntentStore.get("wi-1", operationKey);
    expect(intent?.status).toBe("reconciled");
    expect(intent?.detail.__result).toEqual({ commentId: 5151 });
    expect(intent?.detail.recoveredAfterMutating).toBe(true);
  });

  it("rejects ask publish when the execution epoch is stale", async () => {
    vi.mocked(assertCurrentExecutionEpoch).mockRejectedValueOnce(
      new AppError({
        code: "agent_work.stale_execution_epoch",
        message: "Work-item execution epoch is no longer current",
      }),
    );

    await expect(executeAskJob(cfg, pool, boss, askJob())).rejects.toMatchObject({
      code: "agent_work.stale_execution_epoch",
    });
    expect(repo.recordAskPublishStep).not.toHaveBeenCalled();
  });

  it("does not scan remote comments when no pending intent exists for this ask", async () => {
    vi.mocked(recoverAskReply.findExistingAskReplyComment).mockResolvedValue({ commentId: 9999 });

    await executeAskJob(cfg, pool, boss, askJob());

    expect(recoverAskReply.findExistingAskReplyComment).not.toHaveBeenCalled();
    expect(askRun.runAskRun).toHaveBeenCalledTimes(1);
    expect(durablePrSurfaceControls().replies).toHaveLength(1);
  });
});
