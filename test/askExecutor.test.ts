import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { DurableJobSpec } from "../src/agentWork/durableJob.js";
import type { AskJobData } from "../src/agentWork/types.js";
import { askReplyOperationKey } from "../src/agentWork/withOperationIntent.js";
import { makeTestConfig } from "./helpers/config.js";
import { makeAskWorkItem } from "./helpers/agentWorkItems.js";
import { mockLocalPrWorkspace } from "./helpers/mockWorkspace.js";
import { memoryOperationIntentStore } from "./setup/operationIntent-memory.js";

const mocks = vi.hoisted(() => ({
  hasCompletedPublishStep: vi.fn(),
  recordAskPublishStep: vi.fn(),
  runAskRun: vi.fn(),
  runDurableWorkItem: vi.fn(),
  withPrRepositoryView: vi.fn(),
  postSlashReply: vi.fn(),
  createComment: vi.fn(),
  getAppBotIdentity: vi.fn(),
  findExistingAskReplyComment: vi.fn(),
  paginate: vi.fn(),
}));

vi.mock("../src/agentWork/repository.js", () => ({
  hasCompletedPublishStep: mocks.hasCompletedPublishStep,
  recordAskPublishStep: mocks.recordAskPublishStep,
}));

vi.mock("../src/agent/ask/askRun.js", () => ({
  runAskRun: mocks.runAskRun,
}));

vi.mock("../src/agentWork/durableJob.js", () => ({
  makeInstallationTokenRefresher: vi.fn(() => async () => ({
    token: "tok",
    expiresAtTs: 1_000_000,
    ttlMs: 60_000,
  })),
  runDurableWorkItem: mocks.runDurableWorkItem,
}));

vi.mock("../src/prWorkspace/index.js", () => ({
  withPrRepositoryView: mocks.withPrRepositoryView,
}));

vi.mock("../src/agentWork/githubPrSurface.js", () => ({
  getPullRequestHead: vi.fn(async () => ({ headSha: "head" })),
  postSlashReply: mocks.postSlashReply,
}));

vi.mock("../src/github/appAuth.js", () => ({
  getAppBotIdentity: mocks.getAppBotIdentity,
  installationOctokit: vi.fn(() => ({
    paginate: mocks.paginate,
    rest: {
      issues: { createComment: mocks.createComment, listComments: vi.fn() },
    },
  })),
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
      installation: {
        token: "tok",
        expiresAtTs: 1_000_000,
        ttlMs: 60_000,
      },
      headSha: "head",
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
    mocks.hasCompletedPublishStep.mockResolvedValue(false);
    mocks.recordAskPublishStep.mockResolvedValue(undefined);
    mocks.runAskRun.mockResolvedValue({ answer: "answer" });
    mocks.postSlashReply.mockResolvedValue({ commentId: 9001 });
    mocks.createComment.mockResolvedValue({ data: { id: 9002 } });
    mocks.getAppBotIdentity.mockResolvedValue({ userId: 1, login: "pr-agent[bot]" });
    mocks.findExistingAskReplyComment.mockResolvedValue(null);
    mockDurableExecution();
    mockRepositoryView();
  });

  it("runs the agent and records first answer publish", async () => {
    await executeAskJob(cfg, pool, boss, askJob());

    expect(mocks.runAskRun).toHaveBeenCalledTimes(1);
    expect(mocks.postSlashReply).toHaveBeenCalledTimes(1);
    expect(mocks.postSlashReply).toHaveBeenCalledWith(
      "tok",
      "o",
      "r",
      { kind: "prConversation", prNumber: 1 },
      "answer",
      1_000_000,
    );
    expect(mocks.recordAskPublishStep).toHaveBeenCalledTimes(1);
    expect(mocks.recordAskPublishStep).toHaveBeenCalledWith(pool, {
      workItemId: "wi-1",
      resourceKey: "o/r#1",
      step: "ask_reply",
      detail: { replyTargetKind: "prConversation", commentId: 9001 },
    });
    const intent = memoryOperationIntentStore.get("wi-1", askReplyOperationKey("o/r#1"));
    expect(intent?.status).toBe("reconciled");
    expect(intent?.detail.__result).toEqual({ commentId: 9001 });
  });

  it("skips agent and answer publish when the ask reply was already recorded", async () => {
    mocks.hasCompletedPublishStep.mockResolvedValue(true);

    await executeAskJob(cfg, pool, boss, askJob());

    expect(mocks.withPrRepositoryView).not.toHaveBeenCalled();
    expect(mocks.runAskRun).not.toHaveBeenCalled();
    expect(mocks.postSlashReply).not.toHaveBeenCalled();
    expect(mocks.recordAskPublishStep).not.toHaveBeenCalled();
  });

  it("returns degraded when the publish record fails after answer delivery", async () => {
    let result: unknown;
    mocks.recordAskPublishStep.mockRejectedValue(new Error("record failed"));
    mocks.runDurableWorkItem.mockImplementation(async (spec: DurableJobSpec<"ask">) => {
      result = await spec.execute(askItem(), {
        installation: {
          token: "tok",
          expiresAtTs: 1_000_000,
          ttlMs: 60_000,
        },
        headSha: "head",
      });
    });

    await executeAskJob(cfg, pool, boss, askJob());

    expect(result).toEqual({ degraded: true });
    expect(mocks.runAskRun).toHaveBeenCalledTimes(1);
    expect(mocks.postSlashReply).toHaveBeenCalledTimes(1);
    expect(mocks.recordAskPublishStep).toHaveBeenCalledTimes(1);
  });

  it("skips terminal failure reply after the answer was delivered", async () => {
    mocks.recordAskPublishStep.mockRejectedValue(new Error("record failed"));
    mocks.runDurableWorkItem.mockImplementation(async (spec: DurableJobSpec<"ask">) => {
      const item = askItem();
      const installation = {
        token: "tok",
        expiresAtTs: 1_000_000,
        ttlMs: 60_000,
      };
      await spec.execute(item, {
        installation,
        headSha: "head",
      });
      await spec.onTerminalFailure?.(item, installation, new Error("complete failed"));
    });

    await executeAskJob(cfg, pool, boss, askJob());

    expect(mocks.postSlashReply).toHaveBeenCalledTimes(1);
    expect(mocks.postSlashReply.mock.calls[0]?.[4]).toBe("answer");
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
    mocks.postSlashReply.mockRejectedValueOnce(new Error("thread unavailable"));
    mocks.runDurableWorkItem.mockImplementation(async (spec: DurableJobSpec<"ask">) => {
      await spec.execute(item, {
        installation: {
          token: "tok",
          expiresAtTs: 1_000_000,
          ttlMs: 60_000,
        },
        headSha: "head",
      });
    });

    await executeAskJob(cfg, pool, boss, askJob());

    expect(mocks.postSlashReply).toHaveBeenCalledTimes(1);
    expect(mocks.createComment).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      issue_number: 1,
      body: expect.stringContaining("Could not reply in the review thread"),
    });
    expect(mocks.createComment.mock.calls[0]?.[0].body).toContain("answer");
    expect(mocks.recordAskPublishStep).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        detail: expect.objectContaining({ commentId: 9002 }),
      }),
    );
  });

  it("posts terminal failure reply when the ask never delivered an answer", async () => {
    mocks.runAskRun.mockRejectedValue(new Error("agent failed"));
    mocks.runDurableWorkItem.mockImplementation(async (spec: DurableJobSpec<"ask">) => {
      const item = askItem();
      const installation = {
        token: "tok",
        expiresAtTs: 1_000_000,
        ttlMs: 60_000,
      };
      await expect(
        spec.execute(item, {
          installation,
          headSha: "head",
        }),
      ).rejects.toThrow("agent failed");
      await spec.onTerminalFailure?.(item, installation, new Error("dead"));
    });

    await executeAskJob(cfg, pool, boss, askJob());

    expect(mocks.postSlashReply).toHaveBeenCalledTimes(1);
    expect(mocks.postSlashReply.mock.calls[0]?.[4]).toContain(
      "could not complete this ask after retries",
    );
    expect(mocks.postSlashReply.mock.calls[0]?.[4]).toContain("**Question:** what changed?");
  });

  it("does not post terminal failure reply on non-terminal retry", async () => {
    mocks.runAskRun.mockRejectedValue(new Error("transient"));
    mocks.runDurableWorkItem.mockImplementation(async (spec: DurableJobSpec<"ask">) => {
      const item = askItem();
      const installation = {
        token: "tok",
        expiresAtTs: 1_000_000,
        ttlMs: 60_000,
      };
      await expect(
        spec.execute(item, {
          installation,
          headSha: "head",
        }),
      ).rejects.toThrow("transient");
    });

    await executeAskJob(cfg, pool, boss, askJob());

    expect(mocks.postSlashReply).not.toHaveBeenCalled();
  });

  it("does not remutate or rerun the model after post-mutate / pre-reconcile crash", async () => {
    memoryOperationIntentStore.failNextReconcile(new Error("crash before reconcile"), 1);

    await expect(executeAskJob(cfg, pool, boss, askJob())).rejects.toThrow(
      "crash before reconcile",
    );

    expect(mocks.runAskRun).toHaveBeenCalledTimes(1);
    expect(mocks.postSlashReply).toHaveBeenCalledTimes(1);
    const operationKey = askReplyOperationKey("o/r#1");
    const pending = memoryOperationIntentStore.get("wi-1", operationKey);
    expect(pending?.status).toBe("pending");
    expect(pending?.detail.__result).toEqual({ commentId: 9001 });
    expect(mocks.recordAskPublishStep).not.toHaveBeenCalled();

    mocks.runAskRun.mockClear();
    mocks.postSlashReply.mockClear();
    mocks.findExistingAskReplyComment.mockClear();

    await executeAskJob(cfg, pool, boss, askJob());

    expect(mocks.runAskRun).not.toHaveBeenCalled();
    expect(mocks.postSlashReply).not.toHaveBeenCalled();
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
    expect(mocks.postSlashReply).not.toHaveBeenCalled();
    expect(mocks.findExistingAskReplyComment).toHaveBeenCalledTimes(1);
    expect(mocks.recordAskPublishStep).toHaveBeenCalledWith(pool, {
      workItemId: "wi-1",
      resourceKey: "o/r#1",
      step: "ask_reply",
      detail: { replyTargetKind: "prConversation", commentId: 4242 },
    });
    expect(memoryOperationIntentStore.get("wi-1", askReplyOperationKey("o/r#1"))?.status).toBe(
      "reconciled",
    );
  });

  it("does not scan remote comments when no pending intent exists for this ask", async () => {
    mocks.findExistingAskReplyComment.mockResolvedValue({ commentId: 9999 });

    await executeAskJob(cfg, pool, boss, askJob());

    expect(mocks.findExistingAskReplyComment).not.toHaveBeenCalled();
    expect(mocks.runAskRun).toHaveBeenCalledTimes(1);
    expect(mocks.postSlashReply).toHaveBeenCalledTimes(1);
  });
});
