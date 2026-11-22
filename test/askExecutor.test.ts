import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  legacyIntentStore,
  openExecutorDurableHarness,
  seedPublishStep,
  testFeatureEnv,
  testPublication,
  type ExecutorDurableHarness,
} from "./helpers/executorDurableHarness.ts";
import type { AskWorkItem } from "../src/agentWork/types.ts";
import type { PrSurface } from "../src/github/prSurface.ts";
import type { FeatureWorkExecution } from "../src/agentWork/executors/featureExecution.ts";
import {
  askFailureReplyOperationKey,
  askReplyOperationKey,
} from "../src/state/featurePublication.ts";
import { makeTestConfig } from "./helpers/config.ts";
import {
  durablePrSurfaceControls,
  fakeDurablePrSurface,
  makeDurableJobMetadata,
  mockWorkClaim,
  resetDurablePrSurface,
} from "./helpers/executorDurableHarness.ts";
import { makeAskWorkItem } from "./helpers/agentWorkItems.ts";
import { mockLocalPrWorkspace } from "./helpers/mockWorkspace.ts";
import * as prSurfaceModule from "../src/github/prSurface.ts";

const mocks = vi.hoisted(() => ({
  completed: vi.fn(),
  write: vi.fn(),
  runAskRun: vi.fn(),
  withPrRepositoryView: vi.fn(),
  getAppBotIdentity: vi.fn(),
  findExistingAskReplyComment: vi.fn(),
  recordAskProviderUsage: vi.fn(),
  createAskExecutionId: vi.fn(),
}));

vi.mock("../src/agent/ask/askRun.ts", () => ({
  runAskRun: mocks.runAskRun,
}));

vi.mock("../src/prWorkspace/prRepositoryView.ts", () => ({
  withPrRepositoryView: mocks.withPrRepositoryView,
}));

vi.mock("../src/github/appAuth.ts", () => ({
  getAppBotIdentity: mocks.getAppBotIdentity,
}));

vi.mock("../src/agent/ask/recoverAskReply.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agent/ask/recoverAskReply.ts")>();
  return {
    ...actual,
    findExistingAskReplyComment: mocks.findExistingAskReplyComment,
  };
});

vi.mock("../src/evlog.ts", () => ({
  logWarn: vi.fn(),
}));

vi.mock("../src/state/askQuotas.ts", () => ({
  recordAskProviderUsage: mocks.recordAskProviderUsage,
  createAskExecutionId: mocks.createAskExecutionId,
}));

import { createAskFeatureExecution } from "../src/agentWork/executors/askExecutor.ts";

let harness: ExecutorDurableHarness;
const publishStoreState = {
  get store() {
    return legacyIntentStore(harness.db);
  },
};
const pool = undefined;

let runExecution: () => Promise<unknown>;
function configureExecution(run: (definition: FeatureWorkExecution<"ask">) => Promise<unknown>) {
  runExecution = () =>
    run(
      createAskFeatureExecution({
        cfg,
        botIdentity: () => mocks.getAppBotIdentity(),
      }),
    );
}

const cfg = makeTestConfig({ models: { model: "test" } });

function askItem() {
  return makeAskWorkItem({ headSha: "head" });
}

function publication() {
  return testPublication(harness.db, {
    workId: "wi-1",
    prKey: "o/r#1",
    kind: "ask",
    onRecord: mocks.write,
  });
}

function createDurableExecutionContext(params: {
  readonly item: AskWorkItem;
  readonly prSurface: PrSurface;
  readonly signal?: AbortSignal;
  readonly [key: string]: unknown;
}) {
  return testFeatureEnv(harness.db, {
    item: params.item,
    cfg,
    prSurface: params.prSurface,
    publication: publication(),
    ...(params.signal !== undefined ? { signal: params.signal } : {}),
  });
}

function terminalEnv() {
  return { db: harness.db, cfg, publication: publication() };
}

function mockDurableExecution() {
  configureExecution(async (spec) => {
    await spec.execute(
      askItem(),
      createDurableExecutionContext({
        item: askItem(),
        prSurface: fakeDurablePrSurface(),
      }),
    );
  });
}

function mockRepositoryView() {
  mocks.withPrRepositoryView.mockImplementation(async (_params, run) =>
    run({
      agentCwd: "/tmp/pr-agent",
      workspace: mockLocalPrWorkspace(),
    }),
  );
}

describe("ask work definition", () => {
  afterEach(() => {
    harness.close();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    harness = openExecutorDurableHarness();
    resetDurablePrSurface();
    vi.spyOn(prSurfaceModule, "createPrSurface").mockImplementation(() => fakeDurablePrSurface());
    mocks.write.mockResolvedValue(undefined);
    mocks.runAskRun.mockResolvedValue({ answer: "answer" });
    mocks.recordAskProviderUsage.mockResolvedValue(undefined);
    mocks.createAskExecutionId.mockReturnValue("11111111-1111-4111-8111-111111111111");
    mocks.getAppBotIdentity.mockResolvedValue({ userId: 1, login: "pr-agent[bot]" });
    mocks.findExistingAskReplyComment.mockResolvedValue(null);
    mockDurableExecution();
    mockRepositoryView();
  });

  it("runs the agent and records first answer publish", async () => {
    await runExecution();

    expect(mocks.runAskRun).toHaveBeenCalledTimes(1);
    expect(durablePrSurfaceControls().replies).toHaveLength(1);
    expect(durablePrSurfaceControls().replies[0]?.body).toContain("answer");
    expect(mocks.write).toHaveBeenCalledTimes(1);
    expect(mocks.write).toHaveBeenCalledWith(expect.anything(), {
      workItemId: "wi-1",
      resourceKey: "o/r#1",
      step: "ask_reply",
      reviewLens: "ask",
      detail: {
        replyTargetKind: "prConversation",
        commentId: expect.any(Number),
      },
    });
    const intent = await publishStoreState.store.getOperationIntent(
      undefined,
      "wi-1",
      askReplyOperationKey("o/r#1", 99),
    );
    expect(intent?.status).toBe("reconciled");
    expect(intent?.detail.__result).toMatchObject({
      commentId: expect.any(Number),
    });
    expect(mocks.runAskRun).toHaveBeenCalledWith(expect.objectContaining({ db: harness.db }));
    expect(mocks.recordAskProviderUsage).toHaveBeenCalledWith(expect.anything(), {
      workItemId: "wi-1",
      executionId: "11111111-1111-4111-8111-111111111111",
      usage: undefined,
    });
  });

  it("records known usage under a new execution id for each model run", async () => {
    mocks.createAskExecutionId
      .mockReturnValueOnce("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .mockReturnValueOnce("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    mocks.runAskRun
      .mockResolvedValueOnce({
        answer: "first",
        usage: { estimated: false, totalTokens: 4 },
      })
      .mockResolvedValueOnce({
        answer: "second",
        usage: { estimated: false, totalTokens: 9 },
      });

    await runExecution();
    harness.db.exec("DELETE FROM publish_intents");
    harness.db.exec("DELETE FROM publish_records");
    resetDurablePrSurface();
    await runExecution();

    expect(mocks.runAskRun).toHaveBeenCalledTimes(2);
    expect(mocks.recordAskProviderUsage).toHaveBeenNthCalledWith(1, expect.anything(), {
      workItemId: "wi-1",
      executionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      totalTokens: 4,
    });
    expect(mocks.recordAskProviderUsage).toHaveBeenNthCalledWith(2, expect.anything(), {
      workItemId: "wi-1",
      executionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      totalTokens: 9,
    });
  });

  it("skips agent and answer publish when the ask reply was already recorded", async () => {
    seedPublishStep(harness.db, { workId: "wi-1", lens: "ask", step: "ask_reply", detail: {} });

    await runExecution();

    expect(mocks.withPrRepositoryView).not.toHaveBeenCalled();
    expect(mocks.runAskRun).not.toHaveBeenCalled();
    expect(durablePrSurfaceControls().replies).toHaveLength(0);
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.recordAskProviderUsage).not.toHaveBeenCalled();
    expect(mocks.createAskExecutionId).not.toHaveBeenCalled();
  });

  it("returns degraded when the publish record fails after answer delivery", async () => {
    let result: unknown;
    mocks.write.mockImplementation(() => {
      throw new Error("record failed");
    });
    configureExecution(async (spec) => {
      result = await spec.execute(
        askItem(),
        createDurableExecutionContext({
          pool,
          item: askItem(),
          prSurface: fakeDurablePrSurface(),
          headSha: "head",
          job: makeDurableJobMetadata(),
          beginAttempt: async () => mockWorkClaim(),
          signal: new AbortController().signal,
          getClaim: () => undefined,
          getEscalation: () => undefined,
        }),
      );
    });

    await runExecution();

    expect(result).toMatchObject({ kind: "completed", degradation: ["publish_record_failed"] });
    expect(mocks.runAskRun).toHaveBeenCalledTimes(1);
    expect(durablePrSurfaceControls().replies).toHaveLength(1);
    expect(mocks.write).toHaveBeenCalledTimes(1);
  });

  it("skips terminal failure reply after the answer was delivered", async () => {
    mocks.write.mockImplementation(() => {
      throw new Error("record failed");
    });
    configureExecution(async (spec) => {
      const item = askItem();
      const prSurface = fakeDurablePrSurface();
      await spec.execute(
        item,
        createDurableExecutionContext({
          pool,
          item: item,
          prSurface,
          headSha: "head",
          job: makeDurableJobMetadata(),
          beginAttempt: async () => mockWorkClaim(),
          signal: new AbortController().signal,
          getClaim: () => undefined,
          getEscalation: () => undefined,
        }),
      );
      await spec.onTerminalFailure?.(item, prSurface, terminalEnv());
    });

    await runExecution();

    expect(durablePrSurfaceControls().replies).toHaveLength(1);
    expect(durablePrSurfaceControls().replies[0]?.body).toContain("answer");
  });

  it("skips terminal failure reply when durable ask_reply is already published", async () => {
    seedPublishStep(harness.db, { workId: "wi-1", lens: "ask", step: "ask_reply", detail: {} });
    configureExecution(async (spec) => {
      const item = askItem();
      const prSurface = fakeDurablePrSurface();
      await spec.onTerminalFailure?.(item, prSurface, terminalEnv());
    });

    await runExecution();

    expect(durablePrSurfaceControls().replies).toHaveLength(0);
  });

  it("skips terminal failure reply when a fresh hook finds a stashed ask_reply intent", async () => {
    const operationKey = askReplyOperationKey("o/r#1", 99);
    await publishStoreState.store.persistOperationIntent(undefined, {
      workItemId: "wi-1",
      operationKey,
      mutationKind: "github.ask_reply",
      detail: { step: "ask_reply", reviewLens: "ask", __result: { commentId: 4242 } },
    });
    await publishStoreState.store.reconcileOperationIntent(undefined, {
      workItemId: "wi-1",
      operationKey,
      status: "reconciled",
    });
    configureExecution(async (spec) => {
      const item = askItem();
      const prSurface = fakeDurablePrSurface();
      await spec.onTerminalFailure?.(item, prSurface, terminalEnv());
    });

    await runExecution();

    expect(durablePrSurfaceControls().replies).toHaveLength(0);
  });

  it("skips terminal failure reply when a fresh hook recovers the delivered reply", async () => {
    await publishStoreState.store.persistOperationIntent(undefined, {
      workItemId: "wi-1",
      operationKey: askReplyOperationKey("o/r#1", 99),
      mutationKind: "github.ask_reply",
      detail: { step: "ask_reply" },
    });
    mocks.findExistingAskReplyComment.mockResolvedValue({
      commentId: 5151,
      targetKind: "prConversation",
    });
    configureExecution(async (spec) => {
      const item = askItem();
      const prSurface = fakeDurablePrSurface();
      await spec.onTerminalFailure?.(item, prSurface, terminalEnv());
    });

    await runExecution();

    expect(durablePrSurfaceControls().replies).toHaveLength(0);
    expect(mocks.findExistingAskReplyComment).toHaveBeenCalled();
  });

  it("falls back to one PR comment across retries when inline thread reply fails", async () => {
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
    durablePrSurfaceControls().rejectNextInlineReviewReply(
      Object.assign(new Error("thread unavailable"), { status: 404 }),
    );
    configureExecution(async (spec) => {
      await spec.execute(
        item,
        createDurableExecutionContext({
          pool,
          item: item,
          prSurface: fakeDurablePrSurface(),
          headSha: "head",
          job: makeDurableJobMetadata(),
          beginAttempt: async () => mockWorkClaim(),
          signal: new AbortController().signal,
          getClaim: () => undefined,
          getEscalation: () => undefined,
        }),
      );
    });

    await runExecution();
    await runExecution();

    expect(durablePrSurfaceControls().replies).toHaveLength(1);
    expect(durablePrSurfaceControls().replies[0]?.target).toEqual({
      kind: "prConversation",
      prNumber: 1,
    });
    expect(durablePrSurfaceControls().replies[0]?.body).toContain(
      "Could not reply in the review thread",
    );
    expect(durablePrSurfaceControls().replies[0]?.body).toContain("answer");
    expect(
      await publishStoreState.store.getOperationIntent(
        undefined,
        item.id,
        askReplyOperationKey(item.resourceKey, 99),
      ),
    ).toMatchObject({
      status: "reconciled",
      detail: { __result: expect.objectContaining({ replyTargetKind: "prConversation" }) },
    });
    expect(mocks.write).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        detail: expect.objectContaining({ commentId: expect.any(Number) }),
      }),
    );
  });

  it("reconciles an accepted-then-error inline reply without conversation fallback", async () => {
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
    durablePrSurfaceControls().acceptThenRejectNextInlineReviewReply(
      Object.assign(new Error("GitHub timed out after accepting the reply"), { status: 503 }),
    );
    mocks.findExistingAskReplyComment.mockResolvedValue({
      commentId: 4242,
      targetKind: "inlineReviewThread",
    });
    configureExecution(async (spec) => {
      await spec.execute(
        item,
        createDurableExecutionContext({
          pool,
          item: item,
          prSurface: fakeDurablePrSurface(),
          headSha: "head",
          job: makeDurableJobMetadata(),
          beginAttempt: async () => mockWorkClaim(),
          signal: new AbortController().signal,
          getClaim: () => undefined,
          getEscalation: () => undefined,
        }),
      );
    });

    await runExecution();

    expect(durablePrSurfaceControls().replies).toHaveLength(1);
    expect(durablePrSurfaceControls().replies[0]?.target).toEqual({
      kind: "inlineReviewThread",
      prNumber: 1,
      inReplyToCommentId: 55,
    });
    expect(mocks.write).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        detail: expect.objectContaining({
          replyTargetKind: "inlineReviewThread",
          commentId: 4242,
        }),
      }),
    );
  });

  it("posts terminal failure reply when the ask never delivered an answer", async () => {
    mocks.runAskRun.mockRejectedValue(new Error("agent failed"));
    configureExecution(async (spec) => {
      const item = askItem();
      const prSurface = fakeDurablePrSurface();
      await expect(
        spec.execute(
          item,
          createDurableExecutionContext({
            pool,
            item: item,
            prSurface,
            headSha: "head",
            job: makeDurableJobMetadata(),
            beginAttempt: async () => mockWorkClaim(),
            signal: new AbortController().signal,
            getClaim: () => undefined,
            getEscalation: () => undefined,
          }),
        ),
      ).rejects.toThrow("agent failed");
      await spec.onTerminalFailure?.(item, prSurface, terminalEnv());
    });

    await runExecution();

    expect(durablePrSurfaceControls().replies).toHaveLength(1);
    expect(durablePrSurfaceControls().replies[0]?.body).toContain(
      "could not complete this ask after retries",
    );
    expect(durablePrSurfaceControls().replies[0]?.body).toContain("**Question:** what changed?");
  });

  it("posts exactly one failure reply when a fresh hook finds nothing durable", async () => {
    configureExecution(async (spec) => {
      const item = askItem();
      const prSurface = fakeDurablePrSurface();
      await spec.onTerminalFailure?.(item, prSurface, terminalEnv());
      await spec.onTerminalFailure?.(item, prSurface, terminalEnv());
    });

    await runExecution();

    expect(durablePrSurfaceControls().replies).toHaveLength(1);
    expect(durablePrSurfaceControls().replies[0]?.body).toContain(
      "could not complete this ask after retries",
    );
    const intent = await publishStoreState.store.getOperationIntent(
      undefined,
      "wi-1",
      askFailureReplyOperationKey("o/r#1", 99),
    );
    expect(intent?.status).toBe("reconciled");
    expect(intent?.detail.__result).toMatchObject({ commentId: expect.any(Number) });
  });

  it("posts exactly one failure reply when answer intent is outcome_unknown and nothing was recovered", async () => {
    const answerKey = askReplyOperationKey("o/r#1", 99);
    await publishStoreState.store.persistOperationIntent(undefined, {
      workItemId: "wi-1",
      operationKey: answerKey,
      mutationKind: "github.ask_reply",
      detail: { step: "ask_reply" },
    });
    await publishStoreState.store.reconcileOperationIntent(undefined, {
      workItemId: "wi-1",
      operationKey: answerKey,
      status: "outcome_unknown",
    });
    mocks.findExistingAskReplyComment.mockResolvedValue(null);
    configureExecution(async (spec) => {
      const item = askItem();
      const prSurface = fakeDurablePrSurface();
      await spec.onTerminalFailure?.(item, prSurface, terminalEnv());
      await spec.onTerminalFailure?.(item, prSurface, terminalEnv());
    });

    await runExecution();

    expect(durablePrSurfaceControls().replies).toHaveLength(1);
    expect(durablePrSurfaceControls().replies[0]?.body).toContain(
      "could not complete this ask after retries",
    );
    const failure = await publishStoreState.store.getOperationIntent(
      undefined,
      "wi-1",
      askFailureReplyOperationKey("o/r#1", 99),
    );
    expect(failure?.status).toBe("reconciled");
    expect(failure?.detail.__result).toMatchObject({ commentId: expect.any(Number) });
  });

  it("does not post terminal failure reply on non-terminal retry", async () => {
    mocks.runAskRun.mockRejectedValue(new Error("transient"));
    configureExecution(async (spec) => {
      const item = askItem();
      const prSurface = fakeDurablePrSurface();
      await expect(
        spec.execute(
          item,
          createDurableExecutionContext({
            pool,
            item: item,
            prSurface,
            headSha: "head",
            job: makeDurableJobMetadata(),
            beginAttempt: async () => mockWorkClaim(),
            signal: new AbortController().signal,
            getClaim: () => undefined,
            getEscalation: () => undefined,
          }),
        ),
      ).rejects.toThrow("transient");
    });

    await runExecution();

    expect(durablePrSurfaceControls().replies).toHaveLength(0);
  });

  it("recovers from a remote ask reply when intent is pending without __result", async () => {
    await publishStoreState.store.persistOperationIntent(undefined, {
      workItemId: "wi-1",
      operationKey: askReplyOperationKey("o/r#1", 99),
      mutationKind: "github.ask_reply",
      detail: { step: "ask_reply" },
    });
    mocks.findExistingAskReplyComment.mockResolvedValue({ commentId: 4242 });

    await runExecution();

    expect(mocks.runAskRun).not.toHaveBeenCalled();
    expect(durablePrSurfaceControls().replies).toHaveLength(0);
    expect(mocks.findExistingAskReplyComment).toHaveBeenCalledTimes(1);
    expect(mocks.recordAskProviderUsage).not.toHaveBeenCalled();
    expect(mocks.write).toHaveBeenCalledWith(expect.anything(), {
      workItemId: "wi-1",
      resourceKey: "o/r#1",
      step: "ask_reply",
      reviewLens: "ask",
      detail: { replyTargetKind: "prConversation", commentId: 4242 },
    });
    expect(
      (
        await publishStoreState.store.getOperationIntent(
          undefined,
          "wi-1",
          askReplyOperationKey("o/r#1", 99),
        )
      )?.status,
    ).toBe("reconciled");
  });

  it("recovers a remote ask reply when intent is outcome_unknown without __result", async () => {
    const operationKey = askReplyOperationKey("o/r#1", 99);
    await publishStoreState.store.persistOperationIntent(undefined, {
      workItemId: "wi-1",
      operationKey,
      mutationKind: "github.ask_reply",
      detail: { step: "ask_reply" },
    });
    await publishStoreState.store.reconcileOperationIntent(undefined, {
      workItemId: "wi-1",
      operationKey,
      status: "outcome_unknown",
    });
    mocks.findExistingAskReplyComment.mockResolvedValue({ commentId: 5151 });

    await runExecution();

    expect(mocks.runAskRun).not.toHaveBeenCalled();
    expect(durablePrSurfaceControls().replies).toHaveLength(0);
    expect(mocks.recordAskProviderUsage).not.toHaveBeenCalled();
    expect(mocks.write).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        detail: expect.objectContaining({ commentId: 5151 }),
      }),
    );
    const intent = await publishStoreState.store.getOperationIntent(
      undefined,
      "wi-1",
      operationKey,
    );
    expect(intent?.status).toBe("reconciled");
    expect(intent?.detail.__result).toMatchObject({ commentId: 5151 });
  });

  it("does not scan remote comments when no pending intent exists for this ask", async () => {
    mocks.findExistingAskReplyComment.mockResolvedValue({ commentId: 9999 });

    await runExecution();

    expect(mocks.findExistingAskReplyComment).not.toHaveBeenCalled();
    expect(mocks.runAskRun).toHaveBeenCalledTimes(1);
    expect(durablePrSurfaceControls().replies).toHaveLength(1);
  });
});
