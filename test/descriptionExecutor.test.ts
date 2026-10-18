const publicationWrites = vi.hoisted(() => ({
  write: vi
    .fn<import("../src/agentWork/publishOnce.ts").PublishRecordStore["write"]>()
    .mockResolvedValue(undefined),
}));
vi.mock("../src/agentWork/publishOnce.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agentWork/publishOnce.ts")>();
  return {
    ...actual,
    createPublishContext: (
      client: import("pg").Pool | import("pg").PoolClient,
      identity: import("../src/agentWork/publishOnce.ts").PublicationIdentity,
    ) =>
      actual.createPublishContext(client, identity, {
        ...actual.postgresPublishRecords,
        write: publicationWrites.write,
      }),
  };
});
const recordPublishStep = publicationWrites.write;
import { createDurableExecutionContext } from "../src/agentWork/durableJob.ts";
import { makeDurableJobMetadata } from "./helpers/executorDurableHarness.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import type { EscalationPlan } from "../src/agentWork/retryPolicy.ts";
import { DESCRIPTION_AGENT_HEADER, DESCRIPTION_FAILURE_MESSAGE } from "../src/settings/index.ts";
import { makeTestConfig } from "./helpers/config.ts";
import { makeDescriptionWorkItem } from "./helpers/agentWorkItems.ts";
import { mockLocalPrWorkspace } from "./helpers/mockWorkspace.ts";
import * as repo from "../src/agentWork/workItemStateRepository.ts";
import {
  fakeDurablePrSurface,
  mockWorkClaim,
  resetDurablePrSurface,
  durablePrSurfaceControls,
  setupDefaultDurableRepositoryMocks,
} from "./helpers/executorDurableHarness.ts";
import * as prSurfaceModule from "../src/github/prSurface.ts";

const mocks = vi.hoisted(() => ({
  runDescriptionRun: vi.fn(),
  withPrRepositoryView: vi.fn(),
}));

vi.mock("../src/agentWork/workItemStateRepository.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/agentWork/workItemStateRepository.ts")>();
  return {
    ...actual,
    shouldSkipWork: vi.fn().mockResolvedValue(false),
    getWorkItemCore: vi.fn(),
    getWorkItemPayload: vi.fn(),
    claimWorkForExecution: vi.fn().mockResolvedValue({
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      startedAt: new Date("2026-01-01T00:00:05.000Z"),
      attemptCount: 1,
    }),
    markWorkCompleted: vi.fn().mockResolvedValue(true),
    markWorkFailed: vi.fn().mockResolvedValue(true),
    markWorkRetrying: vi.fn().mockResolvedValue(true),
    markWorkCancelled: vi.fn().mockResolvedValue(true),
    markWorkPublishDegraded: vi.fn().mockResolvedValue(undefined),
    updateRunningWorkHeadSha: vi.fn().mockResolvedValue(true),
  };
});

vi.mock("../src/agent/description/descriptionRun.ts", () => ({
  runFullPrDescription: mocks.runDescriptionRun,
}));

vi.mock("../src/agentWork/prActorLease.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agentWork/prActorLease.ts")>();
  return {
    ...actual,
    isPrActorLeaseHeld: vi.fn().mockResolvedValue(true),
    assertPrActorLeaseHeld: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../src/prWorkspace/prRepositoryView.ts", () => ({
  withPrRepositoryView: mocks.withPrRepositoryView,
}));

vi.mock("../src/github/appAuth.ts", () => ({
  mintInstallationAuth: vi.fn(),
  getAppBotIdentity: vi.fn(),
}));

import { createWorkDefinitions } from "../src/agentWork/workDefinition.ts";
import { openInstallationSurface } from "../src/agentWork/installationSurface.ts";
import * as prActorLease from "../src/agentWork/prActorLease.ts";
import { AppError } from "../src/errors/appError.ts";

let runExecution: () => Promise<unknown>;
function configureExecution(
  run: (definition: ReturnType<typeof createWorkDefinitions>["description"]) => Promise<unknown>,
): void {
  runExecution = () =>
    run(
      createWorkDefinitions({ cfg, pool, boss, installationSurface: openInstallationSurface() })
        .description,
    );
}

const cfg = makeTestConfig({ models: { model: "test" } });
const pool = {} as Pool;
const boss = {} as PgBoss;

function descriptionItem(source: "slash" | "auto" = "slash") {
  return makeDescriptionWorkItem({ source, headSha: "head" });
}

function mockDurableExecution(
  item = descriptionItem(),
  executionEnv: { escalation?: EscalationPlan } = {},
): void {
  configureExecution(async (spec) => {
    const result = await spec.execute(
      item,
      createDurableExecutionContext({
        pool,
        item: item,
        prSurface: fakeDurablePrSurface(),
        headSha: "head",
        leaseEpoch: 1,
        job: makeDurableJobMetadata(),
        beginAttempt: async () => mockWorkClaim(),
        signal: new AbortController().signal,
        getEscalation: () => executionEnv.escalation,
        getClaim: () => undefined,
      }),
    );
    return result;
  });
}

async function runTerminalFailure(
  source: "slash" | "auto",
  prBody = "manual pr body",
): Promise<void> {
  durablePrSurfaceControls().setPullRequestBody(prBody);
  const item = descriptionItem(source);
  configureExecution(async (spec) => {
    await spec.onTerminalFailure?.(item, fakeDurablePrSurface(), new Error("dead"));
  });
  await runExecution();
}

describe("description work definition", () => {
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

    expect(await runExecution()).toMatchObject({
      kind: "completed",
      degradation: ["publish_not_completed"],
    });
  });

  it("does not mark publish degraded when description publishes successfully", async () => {
    const escalation = { attempt: 2, kinds: ["tool_rounds"] } as const;
    mockDurableExecution(descriptionItem(), { escalation });

    await runExecution();

    expect(mocks.runDescriptionRun).toHaveBeenCalledWith(expect.objectContaining({ escalation }));
    expect(repo.markWorkPublishDegraded).not.toHaveBeenCalled();
  });

  it("does not mark publish degraded when publish was superseded", async () => {
    mocks.runDescriptionRun.mockResolvedValue({
      published: false,
      publishSuperseded: true,
    });

    await runExecution();

    expect(repo.markWorkPublishDegraded).not.toHaveBeenCalled();
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

    await runExecution();

    expect(mocks.runDescriptionRun).toHaveBeenCalled();
    expect(repo.markWorkPublishDegraded).not.toHaveBeenCalled();
  });

  it("rejects description publish when the PR actor lease is lost", async () => {
    vi.mocked(recordPublishStep).mockImplementation(async (_pool, params) => {
      if (params.leaseEpoch != null) {
        await prActorLease.assertPrActorLeaseHeld(pool, params.workItemId, params.leaseEpoch);
      }
    });
    vi.mocked(prActorLease.assertPrActorLeaseHeld).mockRejectedValue(
      new AppError({
        domain: "agent_work",
        kind: "pr_actor_lease_lost",
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

    await expect(runExecution()).rejects.toMatchObject({
      code: "agent_work.pr_actor_lease_lost",
    });
  });
});
