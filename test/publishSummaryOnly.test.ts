vi.mock("../src/agentWork/publishOnce.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agentWork/publishOnce.ts")>();
  const { createFakePublishRecords } = await import("../src/agentWork/fakePublishStore.ts");
  const records = createFakePublishRecords(actual.publishStepSpecs);
  return {
    ...actual,
    createPublishContext: (
      client: import("pg").Pool | import("pg").PoolClient,
      identity: import("../src/agentWork/publishOnce.ts").PublicationIdentity,
    ) => actual.createPublishContext(client, identity, records),
  };
});
import { legacyFindingId } from "../src/review/findingIdentity/findingMarker.ts";
import { createFakePublishStore } from "../src/agentWork/fakePublishStore.ts";
const publishStoreState = vi.hoisted(() => {
  let store: import("../src/agentWork/publishOnce.ts").PublishIntentStore;
  return {
    get store() {
      return store;
    },
    set store(value) {
      store = value;
    },
  };
});
vi.mock("../src/agentWork/operationIntentRepository.ts", () => ({
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
  findInFlightMutatingIntent: vi.fn(
    (...args: Parameters<typeof publishStoreState.store.findInFlightMutatingIntent>) =>
      publishStoreState.store.findInFlightMutatingIntent(...args),
  ),
}));
beforeEach(() => {
  publishStoreState.store = createFakePublishStore();
});
vi.mock("../src/agentWork/reconcilePendingIntents.ts", () => ({
  reconcilePendingIntents: vi.fn(async () => ({ reconciled: 0, stillPending: 0 })),
  findCompletedPublishRecordId: vi.fn(async () => null),
}));
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFindingLedger } from "../src/review/orchestrator/orchestratorTypes.ts";
import {
  completeFindingInventory,
  publishSummaryForTest,
} from "./helpers/reviewPublishTestHelpers.ts";
import type { ReviewFinding } from "../src/review/reviewSchema.ts";
import { makeTestConfig } from "./helpers/config.ts";
import { makeReviewPayload } from "./helpers/reviewPayloadFactory.ts";
import { createFakePrSurface } from "../src/github/prSurface.ts";

function configuredSummarySurface() {
  const bundle = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
  bundle.controls.setReviewComments(
    [
      [10, 41],
      [20, 42],
    ].map(([line, id]) => ({
      id,
      inReplyToId: null,
      pullRequestReviewId: null,
      userId: null,
      body: "",
      path: "src/a.ts",
      line,
      originalLine: line,
      htmlUrl: `https://github.com/o/r/pull/1#discussion_r${id}`,
      authorLogin: "pr-agent[bot]",
    })),
  );
  vi.spyOn(bundle.surface, "finishReviewCheck");
  const upsertProgressComment = vi
    .spyOn(bundle.surface, "upsertProgressComment")
    .mockResolvedValue({ id: 2, updated: false });
  const setReviewCommitStatus = vi
    .spyOn(bundle.surface, "setReviewCommitStatus")
    .mockResolvedValue(undefined);
  return { ...bundle, upsertProgressComment, setReviewCommitStatus };
}

vi.mock("../src/github/reviewPublish.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/github/reviewPublish.ts")>();
  return {
    ...actual,
    findIssueCommentBySentinel: vi.fn(async () => null),
    resolveVerifiedSummaryCommentRef: vi.fn(async () => null),
    upsertReviewSummaryComment: vi.fn(async () => ({ id: 2, updated: false })),
    listPullRequestLabels: vi.fn(async () => []),
    setPullRequestLabels: vi.fn(async () => undefined),
    setReviewCommitStatus: vi.fn(async () => undefined),
  };
});

vi.mock("../src/agentWork/workItemStateRepository.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/agentWork/workItemStateRepository.ts")>()),
  getWorkItemCore: vi.fn(async () => ({ type: "review", status: "completed" })),
}));

vi.mock("../src/agentWork/publishRecordRepository.ts", async (importOriginal) => {
  const { createPublishRecordReadMock, createOwnVerdictCloseMock } =
    await import("./helpers/publishReviewTestSetup.ts");
  return {
    ...(await importOriginal<typeof import("../src/agentWork/publishRecordRepository.ts")>()),
    ...createPublishRecordReadMock(),
    ...createOwnVerdictCloseMock(),
  };
});

vi.mock("../src/agentWork/ciProjection.ts", () => ({
  loadRenderableHeadCi: vi.fn(async () => ({
    summary: { status: "pending", headline: "⏳ Waiting for CI", failures: [] },
    version: 0,
  })),
  requestHeadCiProjection: vi.fn(async () => "skipped"),
}));

import * as verdictOwner from "../src/agentWork/reviewVerdict.ts";
import { attachSummaryCommentCoordination } from "../src/review/publish/reviewSummaryComment.ts";
import type { Pool, PoolClient } from "pg";
import { publishReviewSummaryOnly } from "../src/review/publish/publishSummaryOnly.ts";
import { createReviewPublishSession } from "../src/review/publish/reviewPublishSession.ts";
import { openReviewRecovery } from "../src/review/recovery/reviewRecovery.ts";
import {
  createReviewArtifactBinding,
  parseReviewArtifactEnvelope,
} from "../src/review/recovery/reviewArtifacts.ts";

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

  it("prepares final summary inputs and the summary-only ledger before the remote mutation", async () => {
    const binding = createReviewArtifactBinding(
      {
        workItemId: "00000000-0000-4000-8000-000000000001",
        resourceKey: "o/r#1",
        owner: "o",
        repo: "r",
        prNumber: 1,
        installationId: 1,
        baseSha: "base",
        headSha: "head",
        mode: "review",
      },
      "a".repeat(64),
    );
    const rows = new Map<string, unknown>();
    const recovery = openReviewRecovery(binding, {
      load: async (key) => parseReviewArtifactEnvelope(rows.get(key)),
      save: async (envelope) => {
        const parsed = parseReviewArtifactEnvelope(envelope);
        if (!parsed) throw new Error("invalid");
        rows.set(parsed.logicalKey, parsed);
        return "stored";
      },
    });
    const { surface, upsertProgressComment } = configuredSummarySurface();
    upsertProgressComment.mockImplementation(async () => {
      expect(rows.has("final-summary")).toBe(true);
      expect(rows.has("decision/0/prepared")).toBe(true);
      return { id: 2, updated: false };
    });
    const item = finding(10);
    const ledger = createFindingLedger({
      accepted: [
        {
          kind: "summary_only",
          source: "quality",
          placement: {
            finding: item,
            inlineLine: 10,
            inlinePosted: false,
          },
          findingId: legacyFindingId("fp"),
          reason: "budget",
        },
      ],
      threadCallCount: 9,
      threadBudgetExhausted: true,
    });
    const session = createReviewPublishSession({
      cfg: makeTestConfig(),
      ctx: { owner: "o", repo: "r", prNumber: 1, headSha: "head", hasDescriptionReviewMap: false },
      prSurface: surface,
      findingInventory: completeFindingInventory(),
      recovery,
    });
    await expect(
      publishReviewSummaryOnly(session, {
        payload: makeReviewPayload({ findings: [item] }),
        ledger,
        coverage: {
          kind: "partial",
          failed: ["tests"],
          unjudged: ["quality"],
          note: "Partial coverage",
        },
      }),
    ).resolves.toEqual({
      kind: "published",
      summaryCommentId: 2,
      check: { conclusion: "failure", blockingCount: 1 },
    });
    expect(parseReviewArtifactEnvelope(rows.get("final-summary"))?.artifact).toMatchObject({
      inputs: {
        kind: "summary",
        ledger: {
          threadCallCount: 9,
          threadBudgetExhausted: true,
          accepted: [expect.objectContaining({ reason: "budget" })],
        },
        coverage: { kind: "partial", failed: ["tests"], unjudged: ["quality"] },
      },
    });
    expect(parseReviewArtifactEnvelope(rows.get("decision/0/settled"))?.artifact).toMatchObject({
      remote: { githubId: 2 },
    });
    const summaryBody = upsertProgressComment.mock.calls[0]?.[0];
    expect(summaryBody).toContain("Judgment did not finish for quality.");
    expect(summaryBody).toContain("All specialists ran except tests, not judged: quality.");
  });

  it("does not send a summary again after rejection settles stopped", async () => {
    const binding = createReviewArtifactBinding(
      {
        workItemId: "00000000-0000-4000-8000-000000000839",
        resourceKey: "o/r#1",
        owner: "o",
        repo: "r",
        prNumber: 1,
        installationId: 1,
        baseSha: "base",
        headSha: "head",
        mode: "review",
      },
      "b".repeat(64),
    );
    const rows = new Map<string, unknown>();
    const store = {
      load: async (key: string) => parseReviewArtifactEnvelope(rows.get(key)),
      save: async (envelope: unknown) => {
        const parsed = parseReviewArtifactEnvelope(envelope);
        if (!parsed) throw new Error("invalid");
        rows.set(parsed.logicalKey, parsed);
        return "stored" as const;
      },
    };
    const recovery = openReviewRecovery(binding, store);
    const { surface, upsertProgressComment } = configuredSummarySurface();
    upsertProgressComment.mockRejectedValueOnce(
      Object.assign(new Error("GitHub rejected the review"), { status: 403 }),
    );
    const session = createReviewPublishSession({
      cfg: makeTestConfig(),
      ctx: { owner: "o", repo: "r", prNumber: 1, headSha: "head", hasDescriptionReviewMap: false },
      prSurface: surface,
      findingInventory: completeFindingInventory(),
      recovery,
    });
    const payload = makeReviewPayload({ findings: [] });
    const input = {
      payload,
      ledger: createFindingLedger(),
      coverage: { kind: "full" as const },
    };
    await expect(publishReviewSummaryOnly(session, input)).rejects.toThrow(/rejected/);
    expect(upsertProgressComment).toHaveBeenCalledTimes(1);
    const decisions = await recovery.decisions();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.settled?.artifact).toMatchObject({
      kind: "publication_settled",
      outcome: "stopped",
    });
    expect(decisions[0]?.settled?.artifact).not.toHaveProperty("remote");
    await expect(
      publishReviewSummaryOnly(session, { ...input, recoveryDecision: decisions[0] }),
    ).resolves.toEqual({ kind: "stopped", reason: "superseded" });
    expect(upsertProgressComment).toHaveBeenCalledTimes(1);
    expect(await openReviewRecovery(binding, store).decisions()).toHaveLength(1);
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
          findingId: legacyFindingId("fp-1"),
          reviewId: 41,
        },
        {
          kind: "posted",
          source: "security",
          placement: { finding: second, inlineLine: 20, inlinePosted: true },
          findingId: legacyFindingId("fp-2"),
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

    expect(result).toEqual({
      kind: "published",
      summaryCommentId: 2,
      check: { conclusion: "failure", blockingCount: 2 },
    });
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
    expect(close).toHaveBeenCalledWith({
      kind: "published",
      conclusion: "success",
      blockingCount: 0,
    });
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

  it("submits an APPROVE review after a complete summary with no blockers", async () => {
    const pool = { connect: vi.fn() } as unknown as Pool;
    const { surface } = configuredSummarySurface();
    const publishThreadBatch = vi.spyOn(surface, "publishThreadBatch");
    const dismissPullRequestReview = vi.spyOn(surface, "dismissPullRequestReview");
    const result = await publishSummaryForTest({
      cfg: makeTestConfig({
        features: { ...makeTestConfig().features, commitStatus: false, reviewLabels: "off" },
      }),
      ctx: {
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "sha",
        hasDescriptionReviewMap: false,
      },
      prSurface: surface,
      payload: makeReviewPayload({ findings: [] }),
      ledger: createFindingLedger(),
      pool,
      workItemId: "wi-1",
      resourceKey: "o/r#1",
    });
    expect(result.kind).toBe("published");
    expect(publishThreadBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "APPROVE",
        commitId: "sha",
      }),
    );
    const body = publishThreadBatch.mock.calls[0]?.[0]?.body ?? "";
    expect(body).toContain("## PR Agent Review");
    expect(dismissPullRequestReview).not.toHaveBeenCalled();
  });

  it("requests changes for a published failure and leaves prior verdicts standing", async () => {
    const pool = { connect: vi.fn() } as unknown as Pool;
    const { surface, controls } = configuredSummarySurface();
    controls.setPullRequestReviews([
      {
        id: 21,
        userId: 1,
        authorLogin: "pr-agent[bot]",
        body: "prior comment",
        commitId: "old",
        htmlUrl: "https://github.com/o/r/pull/1#pullrequestreview-21",
        state: "APPROVED",
      },
    ]);
    const item = finding(10);
    const ledger = createFindingLedger({
      accepted: [
        {
          kind: "summary_only",
          source: "quality",
          placement: { finding: item, inlineLine: 10, inlinePosted: false },
          findingId: legacyFindingId("fp"),
          reason: "budget",
        },
      ],
    });
    const publishThreadBatch = vi.spyOn(surface, "publishThreadBatch");
    const dismissPullRequestReview = vi.spyOn(surface, "dismissPullRequestReview");
    const result = await publishSummaryForTest({
      cfg: makeTestConfig({
        features: { ...makeTestConfig().features, commitStatus: false, reviewLabels: "off" },
      }),
      ctx: {
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "sha",
        hasDescriptionReviewMap: false,
      },
      prSurface: surface,
      payload: makeReviewPayload({ findings: [item] }),
      ledger,
      pool,
      workItemId: "wi-1",
      resourceKey: "o/r#1",
    });
    expect(result.kind).toBe("published");
    expect(publishThreadBatch).toHaveBeenCalledWith(
      expect.objectContaining({ event: "REQUEST_CHANGES", commitId: "sha" }),
    );
    expect(dismissPullRequestReview).not.toHaveBeenCalled();
  });

  it("comments on a partial run and dismisses this app's standing verdicts", async () => {
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
    const { surface, controls } = configuredSummarySurface();
    controls.setPullRequestReviews([
      {
        id: 11,
        userId: 1,
        authorLogin: "pr-agent[bot]",
        body: "older request",
        commitId: "old-1",
        htmlUrl: "https://github.com/o/r/pull/1#pullrequestreview-11",
        state: "CHANGES_REQUESTED",
      },
      {
        id: 12,
        userId: 1,
        authorLogin: "pr-agent[bot]",
        body: "latest request",
        commitId: "old-2",
        htmlUrl: "https://github.com/o/r/pull/1#pullrequestreview-12",
        state: "CHANGES_REQUESTED",
      },
      {
        id: 13,
        userId: 1,
        authorLogin: "pr-agent[bot]",
        body: "prior approve",
        commitId: "old-3",
        htmlUrl: "https://github.com/o/r/pull/1#pullrequestreview-13",
        state: "APPROVED",
      },
      {
        id: 14,
        userId: 2,
        authorLogin: "human-reviewer",
        body: "human request",
        commitId: "old-4",
        htmlUrl: "https://github.com/o/r/pull/1#pullrequestreview-14",
        state: "CHANGES_REQUESTED",
      },
    ]);
    const publishThreadBatch = vi.spyOn(surface, "publishThreadBatch");
    const dismissPullRequestReview = vi.spyOn(surface, "dismissPullRequestReview");
    const result = await publishSummaryForTest({
      cfg: makeTestConfig({
        features: { ...makeTestConfig().features, commitStatus: false, reviewLabels: "off" },
      }),
      ctx: {
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "sha",
        hasDescriptionReviewMap: false,
      },
      prSurface: surface,
      payload: makeReviewPayload({ findings: [] }),
      ledger: createFindingLedger(),
      recordPublishStep,
      coverage: {
        kind: "partial",
        failed: ["security"],
        note: "Coverage partial: security specialist failed.",
      },
    });
    expect(result.kind).toBe("published");
    expect(publishThreadBatch).toHaveBeenCalledWith(
      expect.objectContaining({ event: "COMMENT", commitId: "sha" }),
    );
    expect(dismissPullRequestReview.mock.calls.map((call) => call[0]?.reviewId).toSorted()).toEqual(
      [11, 12, 13],
    );
    expect(dismissPullRequestReview).not.toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: 14 }),
    );
  });

  it("falls back to COMMENT when GitHub rejects a self-authored APPROVE and then dismisses prior verdicts", async () => {
    const pool = { connect: vi.fn() } as unknown as Pool;
    const { surface, controls } = configuredSummarySurface();
    controls.setPullRequestReviews([
      {
        id: 31,
        userId: 1,
        authorLogin: "pr-agent[bot]",
        body: "standing approve",
        commitId: "old",
        htmlUrl: "https://github.com/o/r/pull/1#pullrequestreview-31",
        state: "APPROVED",
      },
    ]);
    const publishThreadBatch = vi.spyOn(surface, "publishThreadBatch");
    publishThreadBatch.mockRejectedValueOnce(
      Object.assign(new Error("Can not approve your own pull request"), { status: 422 }),
    );
    const dismissPullRequestReview = vi.spyOn(surface, "dismissPullRequestReview");
    const result = await publishSummaryForTest({
      cfg: makeTestConfig({
        features: { ...makeTestConfig().features, commitStatus: false, reviewLabels: "off" },
      }),
      ctx: {
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "sha",
        hasDescriptionReviewMap: false,
      },
      prSurface: surface,
      payload: makeReviewPayload({ findings: [] }),
      ledger: createFindingLedger(),
      pool,
      workItemId: "wi-1",
      resourceKey: "o/r#1",
    });
    expect(result.kind).toBe("published");
    expect(publishThreadBatch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ event: "APPROVE" }),
    );
    expect(publishThreadBatch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ event: "COMMENT", commitId: "sha" }),
    );
    expect(dismissPullRequestReview).toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: 31 }),
    );
  });

  it("keeps the published summary when the terminal review fails", async () => {
    const pool = { connect: vi.fn() } as unknown as Pool;
    const { surface } = configuredSummarySurface();
    vi.spyOn(surface, "publishThreadBatch").mockRejectedValue(new Error("GitHub unavailable"));
    const close = vi.fn<(outcome: verdictOwner.OwnVerdictOutcome) => Promise<void>>(
      async () => undefined,
    );
    const actualVerdict = verdictOwner.reviewVerdict;
    vi.spyOn(verdictOwner, "reviewVerdict").mockImplementation((params) => {
      const verdict = actualVerdict(params);
      return { ...verdict, close };
    });
    const result = await publishSummaryForTest({
      cfg: makeTestConfig({
        features: { ...makeTestConfig().features, commitStatus: false, reviewLabels: "off" },
      }),
      ctx: {
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "sha",
        hasDescriptionReviewMap: false,
      },
      prSurface: surface,
      payload: makeReviewPayload({ findings: [] }),
      ledger: createFindingLedger(),
      pool,
      workItemId: "wi-1",
      resourceKey: "o/r#1",
    });
    expect(result).toEqual({
      kind: "published",
      summaryCommentId: 2,
      check: { conclusion: "success", blockingCount: 0 },
    });
    expect(close).toHaveBeenCalledWith({
      kind: "published",
      conclusion: "success",
      blockingCount: 0,
    });
  });
});
