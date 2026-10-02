vi.mock("../src/agentWork/publishOnce.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agentWork/publishOnce.js")>();
  return {
    ...actual,
    createPublishContext: (
      client: import("pg").Pool | import("pg").PoolClient,
      identity: import("../src/agentWork/publishOnce.js").PublicationIdentity,
    ) => actual.createPublishContext(client, identity, publishStoreState.records),
  };
});
import {
  createFakePublishStore,
  createFakePublishRecords,
} from "../src/agentWork/fakePublishStore.js";
import { publishStepSpecs } from "../src/agentWork/publishOnce.js";
const publishStoreState = vi.hoisted(() => {
  let store: import("../src/agentWork/publishOnce.js").PublishIntentStore;
  let records: import("../src/agentWork/publishOnce.js").PublishRecordStore;
  return {
    get records() {
      return records;
    },
    set records(value) {
      records = value;
    },
    get store() {
      return store;
    },
    set store(value) {
      store = value;
    },
  };
});
vi.mock("../src/agentWork/operationIntentRepository.js", () => ({
  persistOperationIntent: vi.fn(
    (...args: Parameters<typeof publishStoreState.store.persistOperationIntent>) =>
      publishStoreState.store.persistOperationIntent(...args),
  ),
  mergeOperationIntentDetail: vi.fn(
    (...args: Parameters<typeof publishStoreState.store.mergeOperationIntentDetail>) =>
      publishStoreState.store.mergeOperationIntentDetail(...args),
  ),
  reconcileOperationIntent: vi.fn(
    (...args: Parameters<typeof publishStoreState.store.reconcileOperationIntent>) =>
      publishStoreState.store.reconcileOperationIntent(...args),
  ),
  getOperationIntent: vi.fn(
    (...args: Parameters<typeof publishStoreState.store.getOperationIntent>) =>
      publishStoreState.store.getOperationIntent(...args),
  ),
  listPendingOperationIntents: vi.fn(
    (...args: Parameters<typeof publishStoreState.store.listPendingOperationIntents>) =>
      publishStoreState.store.listPendingOperationIntents(...args),
  ),
}));
beforeEach(() => {
  publishStoreState.store = createFakePublishStore();
  publishStoreState.records = createFakePublishRecords(publishStepSpecs);
});
vi.mock("../src/agentWork/reconcilePendingIntents.js", () => ({
  reconcilePendingIntents: vi.fn(async () => ({ reconciled: 0, stillPending: 0 })),
  findCompletedPublishRecordId: vi.fn(async () => null),
}));
import { describe, expect, it, vi, beforeEach } from "vitest";
import { publishReviewForTest } from "./helpers/reviewPublishTestHelpers.js";
import { cachedDiffForLines, testPublishState } from "./helpers/reviewPublishTestHelpers.js";
import {
  createPublishReviewTestHarness,
  publishReviewTestBaseParams,
  publishReviewTestPayload,
  type PublishReviewTestHarness,
} from "./helpers/publishReviewTestSetup.js";

vi.mock("../src/agentWork/repository.js", async () => {
  const { createAgentWorkRepositoryMock } = await import("./helpers/publishReviewTestSetup.js");
  return {
    ...createAgentWorkRepositoryMock(),
    getWorkItemCore: vi.fn(async () => ({ type: "review", status: "completed" })),
  };
});

vi.mock("../src/agentWork/publishRecordRepository.js", async (importOriginal) => {
  const { createOwnVerdictCloseMock } = await import("./helpers/publishReviewTestSetup.js");
  return {
    ...(await importOriginal<typeof import("../src/agentWork/publishRecordRepository.js")>()),
    ...createOwnVerdictCloseMock(),
  };
});

vi.mock("../src/agentWork/ciProjection.js", () => ({
  loadRenderableHeadCi: vi.fn(async () => ({
    summary: { status: "pending", headline: "⏳ Waiting for CI", failures: [] },
    version: 0,
  })),
  enqueueCiProjectionIfDue: vi.fn(async () => undefined),
}));

import { attachSummaryCommentCoordination } from "../src/review/publish/summaryCommentUpsert.js";
import * as verdictOwner from "../src/agentWork/reviewVerdict.js";

const payload = publishReviewTestPayload;
let harness: PublishReviewTestHarness;
let baseParams: ReturnType<typeof publishReviewTestBaseParams>;
const pool = {
  options: { max: 4 },
  connect: vi.fn(async () => ({
    query: vi.fn(async () => ({ rows: [{ locked: true }] })),
    release: vi.fn(),
  })),
} as unknown as import("pg").Pool;

describe("publishReview check run completion", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    harness = createPublishReviewTestHarness();
    baseParams = publishReviewTestBaseParams(harness);
    vi.clearAllMocks();
    harness.upsertProgressComment.mockResolvedValue({ id: 2, updated: false });
  });

  function coordinatedRecordPublishStep() {
    return attachSummaryCommentCoordination(vi.fn(), {
      pool,
      workItemId: "wi-1",
      resourceKey: "o/r#1",
    });
  }

  it("completes the review check as failure when published findings include P1", async () => {
    await publishReviewForTest({
      ...baseParams,
      publishState: testPublishState({ inlineReviewIds: [1] }),
      cachedDiffIndex: cachedDiffForLines("src/x.ts", [4]),
      recordPublishStep: coordinatedRecordPublishStep(),
    });

    expect(harness.surface.finishReviewCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        conclusion: "failure",
        summary: "1 finding",
        detailsUrl: "https://github.com/o/r/pull/1#issuecomment-2",
      }),
    );
  });

  it("completes the review check as failure when findings are P2-only", async () => {
    await publishReviewForTest({
      ...baseParams,
      payload: {
        ...payload,
        findings: [{ ...payload.findings[0], severity: "P2" }],
      },
      publishState: testPublishState({ inlineReviewIds: [1] }),
      cachedDiffIndex: cachedDiffForLines("src/x.ts", [4]),
      recordPublishStep: coordinatedRecordPublishStep(),
    });

    expect(harness.surface.finishReviewCheck).toHaveBeenCalledWith(
      expect.objectContaining({ conclusion: "failure", summary: "1 finding" }),
    );
  });

  it("completes the review check as success when findings are empty", async () => {
    await publishReviewForTest({
      ...baseParams,
      payload: { ...payload, findings: [] },
      publishState: testPublishState({ inlineReviewIds: [1] }),
      cachedDiffIndex: cachedDiffForLines("src/x.ts", [4]),
      recordPublishStep: coordinatedRecordPublishStep(),
    });

    expect(harness.surface.finishReviewCheck).toHaveBeenCalledWith(
      expect.objectContaining({ conclusion: "success", summary: "No findings" }),
    );
  });

  it("completes the review check as success when findings are P3-only", async () => {
    await publishReviewForTest({
      ...baseParams,
      payload: {
        ...payload,
        findings: [
          {
            ...payload.findings[0],
            severity: "P3",
            fixPrompt: "Polish the advisory copy.",
          },
        ],
      },
      publishState: testPublishState({ inlineReviewIds: [1] }),
      cachedDiffIndex: cachedDiffForLines("src/x.ts", [4]),
      recordPublishStep: coordinatedRecordPublishStep(),
    });

    expect(harness.surface.finishReviewCheck).toHaveBeenCalledWith(
      expect.objectContaining({ conclusion: "success", summary: "No findings" }),
    );
  });
});

describe("publishReview commit status", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    harness = createPublishReviewTestHarness();
    baseParams = publishReviewTestBaseParams(harness);
    vi.clearAllMocks();
    harness.upsertProgressComment.mockResolvedValue({ id: 2, updated: false });
  });

  function coordinatedRecordPublishStep() {
    return attachSummaryCommentCoordination(vi.fn(), {
      pool,
      workItemId: "wi-1",
      resourceKey: "o/r#1",
    });
  }

  it("closes the own verdict as failure when published findings include P1", async () => {
    const close = vi.fn<(outcome: verdictOwner.OwnVerdictOutcome) => Promise<void>>(
      async () => undefined,
    );
    const actualVerdict = verdictOwner.reviewVerdict;
    const create = vi.spyOn(verdictOwner, "reviewVerdict").mockImplementation((params) => {
      const verdict = actualVerdict(params);

      return { ...verdict, close };
    });

    await publishReviewForTest({
      ...baseParams,
      cfg: { ...baseParams.cfg, features: { ...baseParams.cfg.features, commitStatus: true } },
      publishState: testPublishState({ inlineReviewIds: [1] }),
      cachedDiffIndex: cachedDiffForLines("src/x.ts", [4]),
      recordPublishStep: coordinatedRecordPublishStep(),
    });

    expect(close).toHaveBeenCalledWith(expect.objectContaining({ kind: "published" }));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ commitStatusEnabled: true }));
    expect(
      verdictOwner.ownVerdictSurfaces(close.mock.calls[0]?.[0] ?? { kind: "not_published" }),
    ).toEqual(expect.objectContaining({ checkRun: "failure", commitStatus: "failure" }));
  });

  it("completes publish when commit status API throws", async () => {
    harness.setReviewCommitStatus.mockRejectedValueOnce(new Error("status api down"));

    await expect(
      publishReviewForTest({
        ...baseParams,
        cfg: { ...baseParams.cfg, features: { ...baseParams.cfg.features, commitStatus: true } },
        publishState: testPublishState({ inlineReviewIds: [1] }),
        cachedDiffIndex: cachedDiffForLines("src/x.ts", [4]),
        recordPublishStep: coordinatedRecordPublishStep(),
      }),
    ).resolves.toBeUndefined();
  });

  it("asks the own verdict writer to skip commit status when the flag is off", async () => {
    const close = vi.fn<(outcome: verdictOwner.OwnVerdictOutcome) => Promise<void>>(
      async () => undefined,
    );
    const actualVerdict = verdictOwner.reviewVerdict;
    const create = vi.spyOn(verdictOwner, "reviewVerdict").mockImplementation((params) => {
      const verdict = actualVerdict(params);

      return { ...verdict, close };
    });

    await publishReviewForTest({
      ...baseParams,
      publishState: testPublishState({ inlineReviewIds: [1] }),
      cachedDiffIndex: cachedDiffForLines("src/x.ts", [4]),
      recordPublishStep: coordinatedRecordPublishStep(),
    });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ commitStatusEnabled: false }));
    expect(harness.setReviewCommitStatus).not.toHaveBeenCalled();
  });
});
