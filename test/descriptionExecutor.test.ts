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
  fakeDurablePrSurface,
  makeDurableJobMetadata,
  mockFetchedWorkItem,
  resetDurablePrSurface,
  durablePrSurfaceControls,
  setupDefaultDurableAuthMocks,
  setupDefaultDurableRepositoryMocks,
} from "./helpers/executorDurableHarness.js";
import * as prSurfaceModule from "../src/github/prSurface.js";

const mocks = vi.hoisted(() => ({
  runDescriptionRun: vi.fn(),
  runDurableWorkItem: vi.fn(),
  withPrRepositoryView: vi.fn(),
}));

vi.mock("../src/agentWork/repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agentWork/repository.js")>();
  return {
    ...actual,
    shouldSkipWork: vi.fn().mockResolvedValue(false),
    getWorkItemCore: vi.fn(),
    getWorkItemPayload: vi.fn(),
    claimWorkForExecution: vi.fn().mockResolvedValue(true),
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

vi.mock("../src/agentWork/prActorLease.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agentWork/prActorLease.js")>();
  return {
    ...actual,
    isPrActorLeaseHeld: vi.fn().mockResolvedValue(true),
    assertPrActorLeaseHeld: vi.fn().mockResolvedValue(undefined),
  };
});

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
}));

import { runDurableWorkItem } from "../src/agentWork/durableJob.js";
import { executeDescriptionJob } from "../src/agentWork/executors/descriptionExecutor.js";
import * as prActorLease from "../src/agentWork/prActorLease.js";
import { AppError } from "../src/errors/appError.js";

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
    const result = await spec.execute(item, {
      prSurface: fakeDurablePrSurface(),
      headSha: "head",
      leaseEpoch: 1,
      signal: new AbortController().signal,
    });
    if (result.kind === "completed" && result.degraded) {
      await repo.markWorkPublishDegraded(pool, item.id, 1);
    }
  });
}

async function runTerminalFailure(
  source: "slash" | "auto",
  prBody = "manual pr body",
): Promise<void> {
  durablePrSurfaceControls().setPullRequestBody(prBody);
  const item = descriptionItem(source);
  mocks.runDurableWorkItem.mockImplementation(async (spec: DurableJobSpec<"description">) => {
    await spec.onTerminalFailure?.(item, fakeDurablePrSurface(), new Error("dead"));
  });
  await executeDescriptionJob(cfg, pool, boss, descriptionJob(3, 3));
}

describe("executeDescriptionJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDurablePrSurface();
    vi.spyOn(prSurfaceModule, "createPrSurface").mockImplementation(() => fakeDurablePrSurface());
    setupDefaultDurableRepositoryMocks();
    mocks.runDescriptionRun.mockResolvedValue({
      published: true,
      publishSuperseded: false,
    });
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

    expect(durablePrSurfaceControls().replies).toHaveLength(1);
    expect(durablePrSurfaceControls().replies[0]?.body).toBe(DESCRIPTION_FAILURE_MESSAGE);
  });

  it("posts auto failure comment when description header is absent", async () => {
    await runTerminalFailure("auto", "manual pr body");

    expect(durablePrSurfaceControls().replies).toHaveLength(1);
  });

  it("stays silent for auto terminal failure when description header is present", async () => {
    await runTerminalFailure("auto", `intro\n${DESCRIPTION_AGENT_HEADER}\ncontent`);

    expect(durablePrSurfaceControls().replies).toHaveLength(0);
  });

  it("marks publish degraded when description run reports unpublished output", async () => {
    mocks.runDescriptionRun.mockResolvedValue({
      published: false,
      publishSuperseded: false,
    });

    await executeDescriptionJob(cfg, pool, boss, descriptionJob());

    expect(repo.markWorkPublishDegraded).toHaveBeenCalledWith(pool, "wi-1", 1);
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
          return { kind: "completed", degraded: true };
        }
        return { kind: "completed" };
      },
    });

    expect(repo.markWorkPublishDegraded).toHaveBeenCalledWith(pool, "wi-1", 1);
  });

  it("treats a lost PR actor lease as publish superseded", async () => {
    vi.mocked(prActorLease.isPrActorLeaseHeld).mockResolvedValue(false);
    mocks.runDescriptionRun.mockImplementation(
      async (params: { shouldAbortPublish?: () => Promise<boolean> }) => {
        const aborted = params.shouldAbortPublish ? await params.shouldAbortPublish() : false;
        return { published: !aborted, publishSuperseded: aborted };
      },
    );
    mockDurableExecution();

    await executeDescriptionJob(cfg, pool, boss, descriptionJob());

    expect(mocks.runDescriptionRun).toHaveBeenCalled();
    expect(repo.markWorkPublishDegraded).not.toHaveBeenCalled();
  });

  it("rejects description publish when the PR actor lease is lost", async () => {
    vi.mocked(repo.recordPublishStep).mockImplementation(async (_pool, params) => {
      if (params.leaseEpoch != null) {
        await prActorLease.assertPrActorLeaseHeld(pool, params.workItemId, params.leaseEpoch);
      }
    });
    vi.mocked(prActorLease.assertPrActorLeaseHeld).mockRejectedValue(
      new AppError({
        code: "agent_work.pr_actor_lease_lost",
        message: "PR actor lease is no longer held by this execution",
      }),
    );
    mocks.runDescriptionRun.mockImplementation(
      async (params: {
        recordPublishStep?: (detail: Record<string, unknown>) => Promise<void>;
      }) => {
        await params.recordPublishStep?.({ body: "x" });
        return { published: true, publishSuperseded: false };
      },
    );
    mockDurableExecution();

    await expect(executeDescriptionJob(cfg, pool, boss, descriptionJob())).rejects.toMatchObject({
      code: "agent_work.pr_actor_lease_lost",
    });
  });
});
