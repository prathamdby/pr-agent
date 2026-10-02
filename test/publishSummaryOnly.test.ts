vi.mock("../src/agentWork/publishOnce.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agentWork/publishOnce.js")>();
  const { createFakePublishRecords } = await import("../src/agentWork/fakePublishStore.js");
  const records = createFakePublishRecords(actual.publishStepSpecs);
  return {
    ...actual,
    createPublishContext: (
      client: import("pg").Pool | import("pg").PoolClient,
      identity: import("../src/agentWork/publishOnce.js").PublicationIdentity,
    ) => actual.createPublishContext(client, identity, records),
  };
});
import { createFakePublishStore } from "../src/agentWork/fakePublishStore.js";
const publishStoreState = vi.hoisted(() => {
  let store: import("../src/agentWork/publishOnce.js").PublishIntentStore;
  return {
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
});
vi.mock("../src/agentWork/reconcilePendingIntents.js", () => ({
  reconcilePendingIntents: vi.fn(async () => ({ reconciled: 0, stillPending: 0 })),
  findCompletedPublishRecordId: vi.fn(async () => null),
}));
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFindingLedger } from "../src/review/orchestrator/orchestratorTypes.js";
import { publishSummaryForTest } from "./helpers/reviewPublishTestHelpers.js";
import type { ReviewFinding } from "../src/review/reviewSchema.js";
import { makeTestConfig } from "./helpers/config.js";
import { makeReviewPayload } from "./helpers/reviewPayloadFactory.js";
import { createFakePrSurface } from "../src/github/prSurface.js";

function configuredSummarySurface() {
  const bundle = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
  vi.spyOn(bundle.surface, "listPullRequestReviewComments").mockResolvedValue({
    comments: [
      {
        path: "src/a.ts",
        line: 10,
        id: 41,
        url: "https://github.com/o/r/pull/1#discussion_r41",
      },
      {
        path: "src/a.ts",
        line: 20,
        id: 42,
        url: "https://github.com/o/r/pull/1#discussion_r42",
      },
    ],
    truncated: false,
  });
  vi.spyOn(bundle.surface, "finishReviewCheck");
  const upsertProgressComment = vi
    .spyOn(bundle.surface, "upsertProgressComment")
    .mockResolvedValue({ id: 2, updated: false });
  const setReviewCommitStatus = vi
    .spyOn(bundle.surface, "setReviewCommitStatus")
    .mockResolvedValue(undefined);
  return { ...bundle, upsertProgressComment, setReviewCommitStatus };
}

vi.mock("../src/github/reviewPublish.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/github/reviewPublish.js")>();
  return {
    ...actual,
    listPullRequestReviewComments: vi.fn(async () => ({
      comments: [
        {
          path: "src/a.ts",
          line: 10,
          id: 41,
          url: "https://github.com/o/r/pull/1#discussion_r41",
        },
        {
          path: "src/a.ts",
          line: 20,
          id: 42,
          url: "https://github.com/o/r/pull/1#discussion_r42",
        },
      ],
      truncated: false,
    })),
    findIssueCommentBySentinel: vi.fn(async () => null),
    resolveVerifiedSummaryCommentRef: vi.fn(async () => null),
    upsertReviewSummaryComment: vi.fn(async () => ({ id: 2, updated: false })),
    listPullRequestLabels: vi.fn(async () => []),
    setPullRequestLabels: vi.fn(async () => undefined),
    setReviewCommitStatus: vi.fn(async () => undefined),
  };
});

vi.mock("../src/agentWork/workItemStateRepository.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/agentWork/workItemStateRepository.js")>()),
  getWorkItemCore: vi.fn(async () => ({ type: "review", status: "completed" })),
}));

vi.mock("../src/agentWork/publishRecordRepository.js", async (importOriginal) => {
  const { createPublishRecordReadMock, createOwnVerdictCloseMock } =
    await import("./helpers/publishReviewTestSetup.js");
  return {
    ...(await importOriginal<typeof import("../src/agentWork/publishRecordRepository.js")>()),
    ...createPublishRecordReadMock(),
    ...createOwnVerdictCloseMock(),
  };
});

vi.mock("../src/agentWork/ciProjection.js", () => ({
  loadRenderableHeadCi: vi.fn(async () => ({
    summary: { status: "pending", headline: "⏳ Waiting for CI", failures: [] },
    version: 0,
  })),
  requestHeadCiProjection: vi.fn(async () => "skipped"),
}));

import * as verdictOwner from "../src/agentWork/reviewVerdict.js";
import { attachSummaryCommentCoordination } from "../src/review/publish/reviewSummaryComment.js";
import type { Pool, PoolClient } from "pg";

function finding(line: number): ReviewFinding {
  return {
    severity: "P1",
    file: "src/a.ts",
    startLine: line,
    endLine: line,
    title: `Bug at line ${line}`,
    detail: `The code at line ${line} returns the wrong value.`,
    fixPrompt: `Fix src/a.ts line ${line}.`,
  };
}

describe("publishReviewSummaryOnly", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("links placements to comments from every inline review batch", async () => {
    const first = finding(10);
    const second = finding(20);
    const payload = makeReviewPayload({
      findings: [first, second],
    });
    const ledger = createFindingLedger({
      accepted: [
        {
          kind: "posted",
          source: "correctness",
          placement: { finding: first, inlineLine: 10, inlinePosted: true },
          canonicalFingerprint: "fp-1",
          reviewId: 41,
        },
        {
          kind: "posted",
          source: "security",
          placement: { finding: second, inlineLine: 20, inlinePosted: true },
          canonicalFingerprint: "fp-2",
          reviewId: 42,
        },
      ],
      inlineReviewIds: [41, 42],
      postedInlineCount: 2,
    });

    const { surface, upsertProgressComment } = configuredSummarySurface();
    const close = vi.fn<(outcome: verdictOwner.OwnVerdictOutcome) => Promise<void>>(
      async () => undefined,
    );
    const actualVerdict = verdictOwner.reviewVerdict;
    const create = vi.spyOn(verdictOwner, "reviewVerdict").mockImplementation((params) => {
      const verdict = actualVerdict(params);
      close.mockImplementation((outcome) => verdict.close(outcome));
      return { ...verdict, close };
    });

    const result = await publishSummaryForTest({
      cfg: makeTestConfig(),
      ctx: {
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "sha",
        hasDescriptionReviewMap: false,
      },
      prSurface: surface,
      payload,
      ledger,
      coverage: {
        kind: "partial",
        failed: ["security"],
        note: "Coverage partial: security specialist failed.",
      },
    });

    expect(result).toEqual({ kind: "published", summaryCommentId: 2 });
    expect(close).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(upsertProgressComment).toHaveBeenCalledTimes(1);
    const summaryBody = upsertProgressComment.mock.calls[0]?.[0];
    expect(summaryBody).toContain("#discussion_r41");
    expect(summaryBody).toContain("#discussion_r42");
    expect(summaryBody).toContain("2 findings block merge.");
    expect(summaryBody).toContain("All specialists ran except security.");
    expect(summaryBody).not.toContain("Coverage partial: security specialist failed.");
    expect(summaryBody?.indexOf("All specialists ran")).toBeLessThan(
      summaryBody?.indexOf("<table>") ?? Number.POSITIVE_INFINITY,
    );
  });

  it("stops before the summary write when the reviewed head is stale", async () => {
    const bundle = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
    const upsertProgressComment = vi.spyOn(bundle.surface, "upsertProgressComment");
    const result = await publishSummaryForTest({
      cfg: makeTestConfig(),
      ctx: {
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "sha",
        hasDescriptionReviewMap: false,
      },
      prSurface: bundle.surface,
      payload: makeReviewPayload({ size: "XS" }),
      ledger: createFindingLedger(),
      shouldAbortPublish: async () => true,
      publishAbortState: { staleHead: true },
    });

    expect(result).toEqual({ kind: "stopped", reason: "stale_head" });
    expect(upsertProgressComment).not.toHaveBeenCalled();
  });

  it("propagates abort-check failures so the durable job can retry", async () => {
    const bundle = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
    const upsertProgressComment = vi.spyOn(bundle.surface, "upsertProgressComment");
    const abortCheckError = new Error("temporary head lookup failure");

    await expect(
      publishSummaryForTest({
        cfg: makeTestConfig(),
        ctx: {
          owner: "o",
          repo: "r",
          prNumber: 1,
          headSha: "sha",
          hasDescriptionReviewMap: false,
        },
        prSurface: bundle.surface,
        payload: makeReviewPayload({ size: "XS" }),
        ledger: createFindingLedger(),
        shouldAbortPublish: async () => {
          throw abortCheckError;
        },
      }),
    ).rejects.toBe(abortCheckError);

    expect(upsertProgressComment).not.toHaveBeenCalled();
  });

  it("forces a neutral check and error commit status for partial coverage", async () => {
    const client = {
      query: vi.fn(async () => ({ rows: [{ locked: true }] })),
      release: vi.fn(),
    } as unknown as PoolClient;
    const pool = {
      options: { max: 4 },
      connect: vi.fn(async () => client),
    } as unknown as Pool;
    const recordPublishStep = attachSummaryCommentCoordination(async () => undefined, {
      pool,
      workItemId: "wi-1",
      resourceKey: "o/r#1",
    });
    const { surface, setReviewCommitStatus, upsertProgressComment } = configuredSummarySurface();
    const close = vi.fn<(outcome: verdictOwner.OwnVerdictOutcome) => Promise<void>>(
      async () => undefined,
    );
    const actualVerdict = verdictOwner.reviewVerdict;
    const create = vi.spyOn(verdictOwner, "reviewVerdict").mockImplementation((params) => {
      const verdict = actualVerdict(params);
      close.mockImplementation((outcome) => verdict.close(outcome));
      return { ...verdict, close };
    });
    const result = await publishSummaryForTest({
      cfg: makeTestConfig({
        features: { ...makeTestConfig().features, commitStatus: true, reviewLabels: "off" },
      }),
      ctx: {
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "sha",
        hasDescriptionReviewMap: false,
      },
      prSurface: surface,
      payload: makeReviewPayload({ findings: [finding(10)] }),
      ledger: createFindingLedger(),
      recordPublishStep,
      coverage: {
        kind: "partial",
        failed: ["security"],
        note: "Coverage partial: security specialist failed.",
      },
    });

    expect(result.kind).toBe("published");
    expect(surface.finishReviewCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        conclusion: "neutral",
        summary: "Coverage partial: security specialist failed.",
      }),
    );
    expect(close).toHaveBeenCalledWith({
      kind: "partial",
      note: "Coverage partial: security specialist failed.",
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ commitStatusEnabled: true }));
    expect(setReviewCommitStatus).toHaveBeenCalledWith(
      "sha",
      expect.objectContaining({ state: "error" }),
    );
    expect(upsertProgressComment).toHaveBeenCalled();
  });

  it("closes the own verdict from pool identity when summary coordination is absent", async () => {
    const pool = { connect: vi.fn() } as unknown as Pool;
    const { surface } = configuredSummarySurface();
    const close = vi.fn<(outcome: verdictOwner.OwnVerdictOutcome) => Promise<void>>(
      async () => undefined,
    );
    const actualVerdict = verdictOwner.reviewVerdict;
    const create = vi.spyOn(verdictOwner, "reviewVerdict").mockImplementation((params) => {
      const verdict = actualVerdict(params);

      return { ...verdict, close };
    });
    const result = await publishSummaryForTest({
      cfg: makeTestConfig({
        features: { ...makeTestConfig().features, commitStatus: true, reviewLabels: "off" },
      }),
      ctx: {
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "sha",
        hasDescriptionReviewMap: false,
      },
      prSurface: surface,
      payload: makeReviewPayload({ findings: [finding(10)] }),
      ledger: createFindingLedger(),
      pool,
      workItemId: "wi-1",
      resourceKey: "o/r#1",
    });

    expect(result.kind).toBe("published");
    expect(close).toHaveBeenCalledWith({ kind: "published", findings: [finding(10)] });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        pool,
        workItemId: "wi-1",
        resourceKey: "o/r#1",
        commitStatusEnabled: true,
      }),
    );
  });

  it("rejects summary publication when every specialist failed", async () => {
    const bundle = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
    const upsertProgressComment = vi.spyOn(bundle.surface, "upsertProgressComment");
    await expect(
      publishSummaryForTest({
        cfg: makeTestConfig(),
        ctx: {
          owner: "o",
          repo: "r",
          prNumber: 1,
          headSha: "sha",
          hasDescriptionReviewMap: false,
        },
        prSurface: bundle.surface,
        payload: makeReviewPayload({ size: "XS" }),
        ledger: createFindingLedger(),
        coverage: {
          kind: "none",
          failed: ["correctness", "security", "quality", "tests"],
        },
      }),
    ).rejects.toMatchObject({ code: "review.summary_coverage_none" });
    expect(upsertProgressComment).not.toHaveBeenCalled();
  });
});
