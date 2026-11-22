import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EscalationPlan } from "../src/agentWork/retryPolicy.ts";
import { DESCRIPTION_AGENT_HEADER, DESCRIPTION_FAILURE_MESSAGE } from "../src/settings/index.ts";
import { makeTestConfig } from "./helpers/config.ts";
import { makeDescriptionWorkItem } from "./helpers/agentWorkItems.ts";
import { mockLocalPrWorkspace } from "./helpers/mockWorkspace.ts";
import {
  fakeDurablePrSurface,
  openExecutorDurableHarness,
  resetDurablePrSurface,
  durablePrSurfaceControls,
  testFeatureEnv,
  testPublication,
  type ExecutorDurableHarness,
} from "./helpers/executorDurableHarness.ts";
import { createDescriptionFeatureExecution } from "../src/agentWork/executors/descriptionExecutor.ts";

const mocks = vi.hoisted(() => ({
  runDescriptionRun: vi.fn(),
  withPrRepositoryView: vi.fn(),
}));

vi.mock("../src/agent/description/descriptionRun.ts", () => ({
  runFullPrDescription: mocks.runDescriptionRun,
}));

vi.mock("../src/prWorkspace/prRepositoryView.ts", () => ({
  withPrRepositoryView: mocks.withPrRepositoryView,
}));

const cfg = makeTestConfig({ models: { model: "test" } });
let harness: ExecutorDurableHarness;

function descriptionItem(source: "slash" | "auto" = "slash") {
  return makeDescriptionWorkItem({ source, headSha: "head" });
}

function execution() {
  return createDescriptionFeatureExecution({
    cfg,
    botIdentity: async () => ({ userId: 1, login: "pr-agent[bot]" }),
  });
}

function publication(item = descriptionItem()) {
  return testPublication(harness.db, {
    workId: item.id,
    prKey: item.resourceKey,
    kind: "description",
  });
}

function runExecution(
  item = descriptionItem(),
  executionEnv: { escalation?: EscalationPlan } = {},
) {
  return execution().execute(
    item,
    testFeatureEnv(harness.db, {
      item,
      cfg,
      prSurface: fakeDurablePrSurface(),
      publication: publication(item),
      ...(executionEnv.escalation !== undefined ? { escalation: executionEnv.escalation } : {}),
    }),
  );
}

async function runTerminalFailure(source: "slash" | "auto", prBody = "manual pr body") {
  durablePrSurfaceControls().setPullRequestBody(prBody);
  const item = descriptionItem(source);
  await execution().onTerminalFailure?.(item, fakeDurablePrSurface(), {
    db: harness.db,
    cfg,
    publication: publication(item),
  });
}

describe("description work definition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness = openExecutorDurableHarness();
    resetDurablePrSurface();
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
  });

  afterEach(() => {
    harness.close();
  });

  it("posts slash failure comment on the terminal attempt", async () => {
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

    const result = await runExecution(descriptionItem(), { escalation });

    expect(mocks.runDescriptionRun).toHaveBeenCalledWith(expect.objectContaining({ escalation }));
    expect(result.degradation).toBeUndefined();
  });

  it("does not mark publish degraded when publish was superseded", async () => {
    mocks.runDescriptionRun.mockResolvedValue({
      published: false,
      publishSuperseded: true,
    });

    const result = await runExecution();

    expect(result.degradation).toBeUndefined();
    expect(result.completion).toMatchObject({ outcome: "superseded" });
  });

  it("treats a cancelled work run as publish superseded", async () => {
    const item = descriptionItem();
    const env = testFeatureEnv(harness.db, {
      item,
      cfg,
      prSurface: fakeDurablePrSurface(),
      publication: publication(item),
    });
    harness.db
      .prepare(`UPDATE work_runs SET cancel_reason = 'superseded' WHERE work_id = ?`)
      .run(item.id);
    mocks.runDescriptionRun.mockImplementation(
      async (params: { shouldAbortPublish?: () => Promise<boolean> }) => {
        const aborted = params.shouldAbortPublish ? await params.shouldAbortPublish() : false;
        return { published: !aborted, publishSuperseded: aborted };
      },
    );

    const result = await execution().execute(item, env);

    expect(mocks.runDescriptionRun).toHaveBeenCalled();
    expect(result.degradation).toBeUndefined();
    expect(result.completion).toMatchObject({ outcome: "superseded" });
  });
});
