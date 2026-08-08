import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { DurableJobSpec } from "../src/agentWork/durableJob.js";
import type { DescriptionJobData } from "../src/agentWork/types.js";
import { DESCRIPTION_AGENT_HEADER, DESCRIPTION_FAILURE_MESSAGE } from "../src/settings/index.js";
import { makeTestConfig } from "./helpers/config.js";
import { makeDescriptionWorkItem } from "./helpers/agentWorkItems.js";
import { mockLocalPrWorkspace } from "./helpers/mockWorkspace.js";
import * as repo from "../src/agentWork/repository.js";
import {
  makeDurableJobMetadata,
  mockFetchedWorkItem,
  setupDefaultDurableAuthMocks,
  setupDefaultDurableRepositoryMocks,
} from "./helpers/executorDurableHarness.js";

const mocks = vi.hoisted(() => ({
  runDescriptionRun: vi.fn(),
  runDurableWorkItem: vi.fn(),
  withPrRepositoryView: vi.fn(),
  pullsGet: vi.fn(),
  createComment: vi.fn(),
}));

vi.mock("../src/agentWork/repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agentWork/repository.js")>();
  return {
    ...actual,
    shouldSkipWork: vi.fn().mockResolvedValue(false),
    getWorkItemCore: vi.fn(),
    getWorkItemPayload: vi.fn(),
    claimWorkForExecution: vi.fn().mockResolvedValue({ executionEpoch: 1 }),
    isExecutionEpochCurrent: vi.fn().mockResolvedValue(true),
    assertCurrentExecutionEpoch: vi.fn().mockResolvedValue(undefined),
    markWorkCompleted: vi.fn().mockResolvedValue(true),
    markWorkFailed: vi.fn().mockResolvedValue(true),
    markWorkRetrying: vi.fn().mockResolvedValue(true),
    markWorkCancelled: vi.fn().mockResolvedValue(undefined),
    markWorkPublishDegraded: vi.fn().mockResolvedValue(undefined),
    updateRunningWorkHeadSha: vi.fn().mockResolvedValue(true),
    recordPublishStep: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../src/agent/description/descriptionRun.js", () => ({
  runFullPrDescription: mocks.runDescriptionRun,
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
  mintInstallationAuth: vi.fn(),
  getAppBotIdentity: vi.fn(),
  installationOctokit: vi.fn(() => ({
    rest: {
      pulls: { get: mocks.pullsGet },
      issues: { createComment: mocks.createComment },
    },
  })),
}));

import { runDurableWorkItem } from "../src/agentWork/durableJob.js";
import { executeDescriptionJob } from "../src/agentWork/executors/descriptionExecutor.js";

const cfg = makeTestConfig({ piModel: "test" });
const pool = {} as Pool;
const boss = {} as PgBoss;

function descriptionItem(source: "slash" | "auto" = "slash") {
  return makeDescriptionWorkItem({ source, headSha: "head" });
}

function descriptionJob(retryCount = 0, retryLimit = 3): JobWithMetadata<DescriptionJobData> {
  const now = new Date();
  return {
    id: "job-1",
    name: "agent-work-description",
    data: { kind: "description", workItemId: "wi-1" },
    expireInSeconds: 3600,
    heartbeatSeconds: null,
    signal: new AbortController().signal,
    priority: 0,
    state: "active",
    retryLimit,
    retryCount,
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

function mockDurableExecution(item = descriptionItem()): void {
  mocks.runDurableWorkItem.mockImplementation(async (spec: DurableJobSpec<"description">) => {
    const installation = {
      token: "tok",
      expiresAtTs: Date.now() + 60_000,
      ttlMs: 60_000,
    };
    const result = await spec.execute(item, {
      installation,
      headSha: "head",
      executionEpoch: 1,
      signal: new AbortController().signal,
    });
    if (result?.degraded) {
      await repo.markWorkPublishDegraded(pool, item.id);
    }
  });
}

async function runTerminalFailure(
  source: "slash" | "auto",
  prBody = "manual pr body",
): Promise<void> {
  mocks.pullsGet.mockResolvedValue({ data: { body: prBody } });
  const item = descriptionItem(source);
  mocks.runDurableWorkItem.mockImplementation(async (spec: DurableJobSpec<"description">) => {
    const installation = {
      token: "tok",
      expiresAtTs: Date.now() + 60_000,
      ttlMs: 60_000,
    };
    await spec.onTerminalFailure?.(item, installation, new Error("dead"));
  });
  await executeDescriptionJob(cfg, pool, boss, descriptionJob(3, 3));
}

describe("executeDescriptionJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultDurableRepositoryMocks();
    mocks.runDescriptionRun.mockResolvedValue({
      published: true,
      publishSuperseded: false,
    });
    mocks.createComment.mockResolvedValue(undefined);
    mocks.pullsGet.mockResolvedValue({ data: { body: "manual pr body" } });
    mocks.withPrRepositoryView.mockImplementation(async (_params, run) =>
      run({
        agentCwd: "/tmp/pr-agent",
        workspace: mockLocalPrWorkspace("/tmp/pr-agent"),
      }),
    );
    mockDurableExecution();
  });

  it("posts slash failure comment on terminal pg-boss attempt", async () => {
    await runTerminalFailure("slash");

    expect(mocks.pullsGet).not.toHaveBeenCalled();
    expect(mocks.createComment).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      issue_number: 1,
      body: DESCRIPTION_FAILURE_MESSAGE,
    });
  });

  it("posts auto failure comment when description header is absent", async () => {
    await runTerminalFailure("auto", "manual pr body");

    expect(mocks.pullsGet).toHaveBeenCalled();
    expect(mocks.createComment).toHaveBeenCalled();
  });

  it("stays silent for auto terminal failure when description header is present", async () => {
    await runTerminalFailure("auto", `intro\n${DESCRIPTION_AGENT_HEADER}\ncontent`);

    expect(mocks.pullsGet).toHaveBeenCalled();
    expect(mocks.createComment).not.toHaveBeenCalled();
  });

  it("marks publish degraded when description run reports unpublished output", async () => {
    mocks.runDescriptionRun.mockResolvedValue({
      published: false,
      publishSuperseded: false,
    });

    await executeDescriptionJob(cfg, pool, boss, descriptionJob());

    expect(repo.markWorkPublishDegraded).toHaveBeenCalledWith(pool, "wi-1");
  });

  it("does not mark publish degraded when description publishes successfully", async () => {
    await executeDescriptionJob(cfg, pool, boss, descriptionJob());

    expect(repo.markWorkPublishDegraded).not.toHaveBeenCalled();
  });

  it("does not mark publish degraded when publish was superseded", async () => {
    mocks.runDescriptionRun.mockResolvedValue({
      published: false,
      publishSuperseded: true,
    });

    await executeDescriptionJob(cfg, pool, boss, descriptionJob());

    expect(repo.markWorkPublishDegraded).not.toHaveBeenCalled();
  });

  it("marks publish degraded through real durable scaffolding", async () => {
    setupDefaultDurableAuthMocks();
    mockFetchedWorkItem(descriptionItem());
    mocks.runDescriptionRun.mockResolvedValue({
      published: false,
      publishSuperseded: false,
    });

    await runDurableWorkItem({
      cfg,
      pool,
      boss,
      job: makeDurableJobMetadata(),
      type: "description",
      resolveHeadSha: async () => ({ headSha: "head" }),
      execute: async (_item, _env) => {
        const result = await mocks.runDescriptionRun({});
        if (!result.published && !result.publishSuperseded) {
          return { degraded: true };
        }
        return {};
      },
    });

    expect(repo.markWorkPublishDegraded).toHaveBeenCalledWith(pool, "wi-1");
  });
});
