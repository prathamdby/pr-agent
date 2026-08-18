import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { DurableJobSpec } from "../src/agentWork/durableJob.js";
import type { AskJobData } from "../src/agentWork/types.js";
import { askReplyOperationKey } from "../src/agentWork/withOperationIntent.js";
import { makeTestConfig } from "./helpers/config.js";
import {
  durablePrSurfaceControls,
  fakeDurablePrSurface,
  resetDurablePrSurface,
} from "./helpers/executorDurableHarness.js";
import { makeAskWorkItem } from "./helpers/agentWorkItems.js";
import { mockLocalPrWorkspace } from "./helpers/mockWorkspace.js";
import { memoryOperationIntentStore } from "./setup/operationIntent-memory.js";
import * as prSurfaceModule from "../src/github/prSurface.js";

const mocks = vi.hoisted(() => ({
  hasCompletedPublishStep: vi.fn(),
  recordAskPublishStep: vi.fn(),
  runAskRun: vi.fn(),
  runDurableWorkItem: vi.fn(),
  withPrRepositoryView: vi.fn(),
  getAppBotIdentity: vi.fn(),
  findExistingAskReplyComment: vi.fn(),
}));

vi.mock("../src/agentWork/repository.js", () => ({
  hasCompletedPublishStep: mocks.hasCompletedPublishStep,
  recordAskPublishStep: mocks.recordAskPublishStep,
}));

vi.mock("../src/agent/ask/askRun.js", () => ({
  runAskRun: mocks.runAskRun,
}));

vi.mock("../src/agentWork/durableJob.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agentWork/durableJob.js")>();
  return {
    ...actual,
    runDurableWorkItem: mocks.runDurableWorkItem,
  };
});

vi.mock("../src/prWorkspace/index.js", () => ({
  withPrRepositoryView: mocks.withPrRepositoryView,
}));

vi.mock("../src/github/appAuth.js", () => ({
  getAppBotIdentity: mocks.getAppBotIdentity,
}));

vi.mock("../src/agent/ask/recoverAskReply.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agent/ask/recoverAskReply.js")>();
  return {
    ...actual,
    findExistingAskReplyComment: mocks.findExistingAskReplyComment,
  };
});

vi.mock("../src/evlog.js", () => ({
  logWarn: vi.fn(),
}));

import { executeAskJob } from "../src/agentWork/executors/askExecutor.js";

const cfg = makeTestConfig({ piModel: "test" });
const pool = {} as Pool;
const boss = {} as PgBoss;

function askItem() {
  return makeAskWorkItem({ headSha: "head" });
}

function askJob(): JobWithMetadata<AskJobData> {
  const now = new Date();
  return {
    id: "job-1",
    name: "agent-work-ask",
    data: { kind: "ask", workItemId: "wi-1" },
    expireInSeconds: 3600,
    heartbeatSeconds: null,
    signal: new AbortController().signal,
    priority: 0,
    state: "active",
    retryLimit: 3,
    retryCount: 0,
    retryDelay: 0,
    retryBackoff: false,
    startAfter: now,
    startedOn: now,
    singletonKey: null,
    singletonOn: null,
    deleteAfterSeconds: 0,
    createdOn: now,
    completedOn: null,
    keepUntil: now,
    policy: "standard",
    heartbeatOn: null,
    blocked: false,
    blocking: false,
    pendingDependencies: 0,
    deadLetter: "",
    output: {},
    sourceName: null,
    sourceId: null,
    sourceCreatedOn: null,
    sourceRetryCount: null,
  };
}

function mockDurableExecution(): void {
  mocks.runDurableWorkItem.mockImplementation(async (spec: DurableJobSpec<"ask">) => {
    await spec.execute(askItem(), {
      prSurface: fakeDurablePrSurface(),
      headSha: "head",
      leaseEpoch: null,
      signal: new AbortController().signal,
    });
  });
}

function mockRepositoryView(): void {
  mocks.withPrRepositoryView.mockImplementation(async (_params, run) =>
    run({
      agentCwd: "/tmp/pr-agent",
      workspace: mockLocalPrWorkspace(),
    }),
  );
}

describe("executeAskJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDurablePrSurface();
    vi.spyOn(prSurfaceModule, "createPrSurface").mockImplementation(() => fakeDurablePrSurface());
    mocks.hasCompletedPublishStep.mockResolvedValue(false);
    mocks.recordAskPublishStep.mockResolvedValue(undefined);
    mocks.runAskRun.mockResolvedValue({ answer: "answer" });
    mocks.getAppBotIdentity.mockResolvedValue({ userId: 1, login: "pr-agent[bot]" });
    mocks.findExistingAskReplyComment.mockResolvedValue(null);
    mockDurableExecution();
    mockRepositoryView();
  });

  it("runs the agent and records first answer publish", async () => {
    await executeAskJob(cfg, pool, boss, askJob());

    expect(mocks.runAskRun).toHaveBeenCalledTimes(1);
    expect(durablePrSurfaceControls().replies).toHaveLength(1);
    expect(durablePrSurfaceControls().replies[0]?.body).toBe("answer");
    expect(mocks.recordAskPublishStep).toHaveBeenCalledTimes(1);
    expect(mocks.recordAskPublishStep).toHaveBeenCalledWith(pool, {
      workItemId: "wi-1",
      resourceKey: "o/r#1",
      step: "ask_reply",
      detail: {
        replyTargetKind: "prConversation",
        commentId: expect.any(Number),
      },
      leaseEpoch: null,
    });
    const intent = memoryOperationIntentStore.get("wi-1", askReplyOperationKey("o/r#1"));
    expect(intent?.status).toBe("reconciled");
    expect(intent?.detail.__result).toEqual({
      commentId: expect.any(Number),
    });
  });

  it("skips agent and answer publish when the ask reply was already recorded", async () => {
    mocks.hasCompletedPublishStep.mockResolvedValue(true);

    await executeAskJob(cfg, pool, boss, askJob());

    expect(mocks.withPrRepositoryView).not.toHaveBeenCalled();
    expect(mocks.runAskRun).not.toHaveBeenCalled();
    expect(durablePrSurfaceControls().replies).toHaveLength(0);
    expect(mocks.recordAskPublishStep).not.toHaveBeenCalled();
  });

  it("returns degraded when the publish record fails after answer delivery", async () => {
    let result: unknown;
    mocks.recordAskPublishStep.mockRejectedValue(new Error("record failed"));
    mocks.runDurableWorkItem.mockImplementation(async (spec: DurableJobSpec<"ask">) => {
      result = await spec.execute(askItem(), {
        prSurface: fakeDurablePrSurface(),
        headSha: "head",
        leaseEpoch: null,
        signal: new AbortController().signal,
      });
    });

    await executeAskJob(cfg, pool, boss, askJob());

    expect(result).toEqual({ kind: "completed", degraded: true });
    expect(mocks.runAskRun).toHaveBeenCalledTimes(1);
    expect(durablePrSurfaceControls().replies).toHaveLength(1);
    expect(mocks.recordAskPublishStep).toHaveBeenCalledTimes(1);
  });

  it("skips terminal failure reply after the answer was delivered", async () => {
    mocks.recordAskPublishStep.mockRejectedValue(new Error("record failed"));
    mocks.runDurableWorkItem.mockImplementation(async (spec: DurableJobSpec<"ask">) => {
      const item = askItem();
      const prSurface = fakeDurablePrSurface();
      await spec.execute(item, {
        prSurface,
        headSha: "head",
        leaseEpoch: null,
        signal: new AbortController().signal,
      });
      await spec.onTerminalFailure?.(item, prSurface, new Error("complete failed"));
    });

    await executeAskJob(cfg, pool, boss, askJob());

    expect(durablePrSurfaceControls().replies).toHaveLength(1);
    expect(durablePrSurfaceControls().replies[0]?.body).toBe("answer");
  });

  it("skips terminal failure reply when durable ask_reply is already published", async () => {
    mocks.hasCompletedPublishStep.mockResolvedValue(true);
    mocks.runDurableWorkItem.mockImplementation(async (spec: DurableJobSpec<"ask">) => {
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
    mocks.runDurableWorkItem.mockImplementation(async (spec: DurableJobSpec<"ask">) => {
      await spec.execute(item, {
        prSurface: fakeDurablePrSurface(),
        headSha: "head",
        leaseEpoch: null,
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
    expect(mocks.recordAskPublishStep).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        detail: expect.objectContaining({ commentId: expect.any(Number) }),
      }),
    );
  });

  it("posts terminal failure reply when the ask never delivered an answer", async () => {
    mocks.runAskRun.mockRejectedValue(new Error("agent failed"));
    mocks.runDurableWorkItem.mockImplementation(async (spec: DurableJobSpec<"ask">) => {
      const item = askItem();
      const prSurface = fakeDurablePrSurface();
      await expect(
        spec.execute(item, {
          prSurface,
          headSha: "head",
          leaseEpoch: null,
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
    mocks.runAskRun.mockRejectedValue(new Error("transient"));
    mocks.runDurableWorkItem.mockImplementation(async (spec: DurableJobSpec<"ask">) => {
      const item = askItem();
      const prSurface = fakeDurablePrSurface();
      await expect(
        spec.execute(item, {
          prSurface,
          headSha: "head",
          leaseEpoch: null,
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

    expect(mocks.runAskRun).toHaveBeenCalledTimes(1);
    expect(durablePrSurfaceControls().replies).toHaveLength(1);
    const operationKey = askReplyOperationKey("o/r#1");
    const pending = memoryOperationIntentStore.get("wi-1", operationKey);
    expect(pending?.status).toBe("pending");
    expect(pending?.detail.__result).toEqual({ commentId: expect.any(Number) });
    expect(mocks.recordAskPublishStep).not.toHaveBeenCalled();

    mocks.runAskRun.mockClear();
    mocks.findExistingAskReplyComment.mockClear();
    resetDurablePrSurface();
    vi.spyOn(prSurfaceModule, "createPrSurface").mockImplementation(() => fakeDurablePrSurface());

    await executeAskJob(cfg, pool, boss, askJob());

    expect(mocks.runAskRun).not.toHaveBeenCalled();
    expect(durablePrSurfaceControls().replies).toHaveLength(0);
    expect(mocks.findExistingAskReplyComment).not.toHaveBeenCalled();
    expect(mocks.recordAskPublishStep).toHaveBeenCalledTimes(1);
    expect(memoryOperationIntentStore.get("wi-1", operationKey)?.status).toBe("reconciled");
  });

  it("recovers from a remote ask reply when intent is pending without __result", async () => {
    await memoryOperationIntentStore.persist(pool, {
      workItemId: "wi-1",
      operationKey: askReplyOperationKey("o/r#1"),
      mutationKind: "github.ask_reply",
      detail: { step: "ask_reply" },
    });
    mocks.findExistingAskReplyComment.mockResolvedValue({ commentId: 4242 });

    await executeAskJob(cfg, pool, boss, askJob());

    expect(mocks.runAskRun).not.toHaveBeenCalled();
    expect(durablePrSurfaceControls().replies).toHaveLength(0);
    expect(mocks.findExistingAskReplyComment).toHaveBeenCalledTimes(1);
    expect(mocks.recordAskPublishStep).toHaveBeenCalledWith(pool, {
      workItemId: "wi-1",
      resourceKey: "o/r#1",
      step: "ask_reply",
      detail: { replyTargetKind: "prConversation", commentId: 4242 },
      leaseEpoch: null,
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
    mocks.findExistingAskReplyComment.mockResolvedValue({ commentId: 5151 });

    await executeAskJob(cfg, pool, boss, askJob());

    expect(mocks.runAskRun).not.toHaveBeenCalled();
    expect(durablePrSurfaceControls().replies).toHaveLength(0);
    expect(mocks.recordAskPublishStep).toHaveBeenCalledWith(
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

  it("does not scan remote comments when no pending intent exists for this ask", async () => {
    mocks.findExistingAskReplyComment.mockResolvedValue({ commentId: 9999 });

    await executeAskJob(cfg, pool, boss, askJob());

    expect(mocks.findExistingAskReplyComment).not.toHaveBeenCalled();
    expect(mocks.runAskRun).toHaveBeenCalledTimes(1);
    expect(durablePrSurfaceControls().replies).toHaveLength(1);
  });
});
