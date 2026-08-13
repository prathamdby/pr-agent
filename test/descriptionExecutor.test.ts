import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { PgBoss } from "pg-boss";
import type { JobWithMetadata } from "pg-boss";
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
import { resetCreatePrSurface, setCreatePrSurface } from "../src/github/prSurface.js";
import * as descriptionRun from "../src/agent/description/descriptionRun.js";
import * as durableJob from "../src/agentWork/durableJob.js";
import { runDurableWorkItem } from "../src/agentWork/durableJob.js";
import * as prWorkspace from "../src/prWorkspace/index.js";
import { executeDescriptionJob } from "../src/agentWork/executors/descriptionExecutor.js";
import { AppError } from "../src/errors/appError.js";
import type { PrRepositoryView } from "../src/prWorkspace/prRepositoryView.js";
import { assistantFromText } from "../src/agentRun/sessionHelpers.js";
import type { DescriptionRunResult } from "../src/agent/description/descriptionRun.js";

const cfg = makeTestConfig({ piModel: "test" });
const pool = new Pool({ connectionString: "postgres://127.0.0.1:1/unused" });
const boss = new PgBoss({ connectionString: "postgres://127.0.0.1:1/unused" });

const emptyPreflight = {
  files: [] as const,
  truncated: false,
  fileCount: 0,
  totalChanges: 0,
};

function descriptionRunResult(overrides: Partial<DescriptionRunResult> = {}): DescriptionRunResult {
  return {
    published: true,
    publishSuperseded: false,
    lastAssistant: assistantFromText(cfg, "", cfg.piProvider),
    ...overrides,
  };
}

function repositoryView(): PrRepositoryView {
  return {
    agentCwd: "/tmp/pr-agent",
    workspace: mockLocalPrWorkspace("/tmp/pr-agent"),
    preflight: emptyPreflight,
  };
}

function descriptionItem(source: "slash" | "auto" = "slash") {
  return makeDescriptionWorkItem({ source, headSha: "head" });
}

function descriptionJob(retryCount = 0, retryLimit = 3): JobWithMetadata<DescriptionJobData> {
  return {
    ...makeDurableJobMetadata("wi-1", retryCount, retryLimit),
    name: "agent-work-description",
    data: { kind: "description", workItemId: "wi-1" },
  };
}

function mockDurableExecution(item = descriptionItem()): void {
  vi.mocked(durableJob.runDurableWorkItem).mockImplementation(async (spec) => {
    if (spec.type !== "description") return;
    const result = await spec.execute(item, {
      prSurface: fakeDurablePrSurface(),
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
  durablePrSurfaceControls().setPullRequestBody(prBody);
  const item = descriptionItem(source);
  vi.mocked(durableJob.runDurableWorkItem).mockImplementation(async (spec) => {
    if (spec.type !== "description") return;
    await spec.onTerminalFailure?.(item, fakeDurablePrSurface(), new Error("dead"));
  });
  await executeDescriptionJob(cfg, pool, boss, descriptionJob(3, 3));
}

describe("executeDescriptionJob", () => {
  beforeEach(() => {
    resetDurablePrSurface();
    setCreatePrSurface(() => fakeDurablePrSurface());
    setupDefaultDurableRepositoryMocks();
    vi.spyOn(repo, "recordPublishStep").mockResolvedValue(undefined);
    vi.spyOn(repo, "assertCurrentExecutionEpoch").mockResolvedValue(undefined);
    vi.spyOn(descriptionRun, "runFullPrDescription").mockResolvedValue(descriptionRunResult());
    vi.spyOn(prWorkspace, "withPrRepositoryView").mockImplementation(async (_params, run) =>
      run(repositoryView()),
    );
    vi.spyOn(durableJob, "runDurableWorkItem");
    mockDurableExecution();
  });

  afterEach(() => {
    resetCreatePrSurface();
    vi.restoreAllMocks();
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
    vi.mocked(descriptionRun.runFullPrDescription).mockResolvedValue(
      descriptionRunResult({ published: false, publishSuperseded: false }),
    );

    await executeDescriptionJob(cfg, pool, boss, descriptionJob());

    expect(repo.markWorkPublishDegraded).toHaveBeenCalledWith(pool, "wi-1");
  });

  it("does not mark publish degraded when description publishes successfully", async () => {
    await executeDescriptionJob(cfg, pool, boss, descriptionJob());

    expect(repo.markWorkPublishDegraded).not.toHaveBeenCalled();
  });

  it("does not mark publish degraded when publish was superseded", async () => {
    vi.mocked(descriptionRun.runFullPrDescription).mockResolvedValue(
      descriptionRunResult({ published: false, publishSuperseded: true }),
    );

    await executeDescriptionJob(cfg, pool, boss, descriptionJob());

    expect(repo.markWorkPublishDegraded).not.toHaveBeenCalled();
  });

  it("marks publish degraded through real durable scaffolding", async () => {
    setupDefaultDurableAuthMocks();
    mockFetchedWorkItem(descriptionItem());
    vi.mocked(descriptionRun.runFullPrDescription).mockResolvedValue(
      descriptionRunResult({ published: false, publishSuperseded: false }),
    );

    await runDurableWorkItem({
      cfg,
      pool,
      boss,
      job: makeDurableJobMetadata(),
      type: "description",
      resolveHeadSha: async () => ({ headSha: "head" }),
      execute: async (_item, _env) => {
        const result = await descriptionRun.runFullPrDescription({
          cfg,
          prSurface: fakeDurablePrSurface(),
          owner: "o",
          repo: "r",
          prNumber: 1,
          headSha: "head",
          workspace: mockLocalPrWorkspace("/tmp/pr-agent"),
        });
        if (!result.published && !result.publishSuperseded) {
          return { degraded: true };
        }
        return {};
      },
    });

    expect(repo.markWorkPublishDegraded).toHaveBeenCalledWith(pool, "wi-1");
  });

  it("treats a stale execution epoch as publish superseded", async () => {
    vi.mocked(repo.isExecutionEpochCurrent).mockResolvedValue(false);
    vi.mocked(descriptionRun.runFullPrDescription).mockImplementation(async (params) => {
      const aborted = params.shouldAbortPublish ? await params.shouldAbortPublish() : false;
      return descriptionRunResult({ published: !aborted, publishSuperseded: aborted });
    });
    mockDurableExecution();

    await executeDescriptionJob(cfg, pool, boss, descriptionJob());

    expect(descriptionRun.runFullPrDescription).toHaveBeenCalled();
    expect(repo.markWorkPublishDegraded).not.toHaveBeenCalled();
  });

  it("rejects description publish when assertCurrentExecutionEpoch fails", async () => {
    vi.mocked(repo.recordPublishStep).mockImplementation(async (_pool, params) => {
      if (params.executionEpoch != null) {
        await repo.assertCurrentExecutionEpoch(pool, params.workItemId, params.executionEpoch);
      }
    });
    vi.mocked(repo.assertCurrentExecutionEpoch).mockRejectedValue(
      new AppError({
        code: "agent_work.stale_execution_epoch",
        message: "Work-item execution epoch is no longer current",
      }),
    );
    vi.mocked(descriptionRun.runFullPrDescription).mockImplementation(async (params) => {
      await params.recordPublishStep?.({ body: "x" });
      return descriptionRunResult();
    });
    mockDurableExecution();

    await expect(executeDescriptionJob(cfg, pool, boss, descriptionJob())).rejects.toMatchObject({
      code: "agent_work.stale_execution_epoch",
    });
  });
});
