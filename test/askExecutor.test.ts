import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { DurableJobSpec } from "../src/agentWork/durableJob.js";
import type { AgentWorkItem, AskJobData } from "../src/agentWork/types.js";
import { makeTestConfig } from "./helpers/config.js";

const mocks = vi.hoisted(() => ({
  hasCompletedPublishStep: vi.fn(),
  recordPublishStep: vi.fn(),
  runAskRun: vi.fn(),
  runDurableWorkItem: vi.fn(),
  withPrRepositoryView: vi.fn(),
  postSlashReply: vi.fn(),
}));

vi.mock("../src/agentWork/repository.js", () => ({
  hasCompletedPublishStep: mocks.hasCompletedPublishStep,
  recordPublishStep: mocks.recordPublishStep,
}));

vi.mock("../src/agent/askRun.js", () => ({
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
  installationOctokit: vi.fn(() => ({
    rest: {
      issues: { createComment: vi.fn() },
    },
  })),
}));

vi.mock("../src/evlog.js", () => ({
  logWarn: vi.fn(),
}));

import { executeAskJob } from "../src/agentWork/executors/askExecutor.js";

const cfg = makeTestConfig({ piModel: "test" });
const pool = {} as Pool;
const boss = {} as PgBoss;

function askItem(): AgentWorkItem {
  return {
    id: "wi-1",
    webhookEventId: "ev-1",
    type: "ask",
    source: "slash",
    status: "running",
    owner: "o",
    repo: "r",
    prNumber: 1,
    installationId: 42,
    headSha: "head",
    reviewLens: null,
    resourceKey: "o/r#1",
    attemptCount: 0,
    payload: {
      question: "what changed?",
      replyTarget: { kind: "prConversation", prNumber: 1 },
      commentId: 99,
    },
    cancelRequestedAt: null,
  };
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
    deadLetter: "",
    output: {},
  };
}

function mockDurableExecution(): void {
  mocks.runDurableWorkItem.mockImplementation(async (spec: DurableJobSpec) => {
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
      workspace: undefined,
    }),
  );
}

describe("executeAskJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasCompletedPublishStep.mockResolvedValue(false);
    mocks.recordPublishStep.mockResolvedValue(undefined);
    mocks.runAskRun.mockResolvedValue({ answer: "answer" });
    mocks.postSlashReply.mockResolvedValue(undefined);
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
    expect(mocks.recordPublishStep).toHaveBeenCalledTimes(1);
    expect(mocks.recordPublishStep).toHaveBeenCalledWith(pool, {
      workItemId: "wi-1",
      resourceKey: "o/r#1",
      reviewLens: "ask",
      step: "ask_reply",
      detail: { replyTargetKind: "prConversation" },
    });
  });

  it("skips agent and answer publish when the ask reply was already recorded", async () => {
    mocks.hasCompletedPublishStep.mockResolvedValue(true);

    await executeAskJob(cfg, pool, boss, askJob());

    expect(mocks.withPrRepositoryView).not.toHaveBeenCalled();
    expect(mocks.runAskRun).not.toHaveBeenCalled();
    expect(mocks.postSlashReply).not.toHaveBeenCalled();
    expect(mocks.recordPublishStep).not.toHaveBeenCalled();
  });

  it("attempts answer publish again when the publish record is missing after a crash", async () => {
    mocks.recordPublishStep
      .mockRejectedValueOnce(new Error("record failed"))
      .mockResolvedValueOnce(undefined);

    await expect(executeAskJob(cfg, pool, boss, askJob())).rejects.toThrow("record failed");
    await executeAskJob(cfg, pool, boss, askJob());

    expect(mocks.runAskRun).toHaveBeenCalledTimes(2);
    expect(mocks.postSlashReply).toHaveBeenCalledTimes(2);
    expect(mocks.recordPublishStep).toHaveBeenCalledTimes(2);
  });

  it("skips terminal failure reply after the answer was delivered", async () => {
    mocks.recordPublishStep.mockRejectedValue(new Error("record failed"));
    mocks.runDurableWorkItem.mockImplementation(async (spec: DurableJobSpec) => {
      const item = askItem();
      const installation = {
        token: "tok",
        expiresAtTs: 1_000_000,
        ttlMs: 60_000,
      };
      try {
        await spec.execute(item, {
          installation,
          headSha: "head",
        });
      } catch (error) {
        await spec.onTerminalFailure?.(item, installation, error);
        throw error;
      }
    });

    await expect(executeAskJob(cfg, pool, boss, askJob())).rejects.toThrow("record failed");

    expect(mocks.postSlashReply).toHaveBeenCalledTimes(1);
    expect(mocks.postSlashReply.mock.calls[0]?.[4]).toBe("answer");
  });
});
