const publicationWrites = vi.hoisted(() => ({
  write: vi
    .fn<import("../src/agentWork/publishOnce.js").PublishRecordStore["write"]>()
    .mockResolvedValue(undefined),
}));
vi.mock("../src/agentWork/publishOnce.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agentWork/publishOnce.js")>();
  return {
    ...actual,
    createPublishContext: (
      client: import("pg").Pool | import("pg").PoolClient,
      identity: import("../src/agentWork/publishOnce.js").PublicationIdentity,
    ) =>
      actual.createPublishContext(client, identity, {
        ...actual.postgresPublishRecords,
        write: publicationWrites.write,
      }),
  };
});
const recordPublishStep = publicationWrites.write;
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
vi.mock("../src/agentWork/prActorLease.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/agentWork/prActorLease.js")>()),
  assertPrActorLeaseHeld: vi.fn(async () => undefined),
}));
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { tryLightweightAutoReviewCompletion } from "../src/agentWork/reviewLightweightCompletion.js";
import type { AgentWorkItem } from "../src/agentWork/types.js";
import { REVIEW_SUMMARY_SENTINEL } from "../src/review/reviewSchema.js";
import { createFakePrSurface } from "../src/github/prSurface.js";
import { LIGHTWEIGHT_REVIEW_COMPLETION_LEAD } from "../src/settings/index.js";

vi.mock("../src/agentWork/publishRecordRepository.js", () => ({
  getSummaryCommentGithubId: vi.fn(async () => null),
}));

vi.mock("../src/agentWork/workItemStateRepository.js", () => ({
  shouldSkipWork: vi.fn(),
}));

vi.mock("../src/review/run/reviewRunMetrics.js", () => ({
  snapshotReviewRunMetrics: vi.fn(() => null),
}));

vi.mock("../src/agentWork/ciProjection.js", () => ({
  loadRenderableHeadCi: vi.fn(async () => ({
    summary: { status: "pending", headline: "CI is pending", failures: [] },
    version: 1,
  })),
  requestHeadCiProjection: vi.fn(async () => "skipped"),
}));

const summaryWrite = vi.hoisted(() =>
  vi.fn(
    async (params: {
      readonly prSurface: import("../src/github/prSurface.js").PrSurface;
      readonly body: string;
      readonly hintCommentId?: number | null;
      readonly [key: string]: unknown;
    }) =>
      params.prSurface.upsertProgressComment(
        params.body,
        "## PR Agent Review",
        params.hintCommentId != null
          ? { id: params.hintCommentId, url: "https://example.com/c" }
          : null,
      ),
  ),
);

vi.mock("../src/review/publish/reviewSummaryComment.js", () => ({
  createReviewSummaryComment: (deps: {
    readonly prSurface: import("../src/github/prSurface.js").PrSurface;
    readonly reviewLens: string;
    readonly coordination?: object;
  }) => ({
    conclude: (write: { readonly body: string; readonly hintCommentId?: number | null }) =>
      summaryWrite({
        prSurface: deps.prSurface,
        reviewLens: deps.reviewLens,
        ...deps.coordination,
        ...write,
        progressRevision: 7,
      }),
  }),
}));

import { getSummaryCommentGithubId } from "../src/agentWork/publishRecordRepository.js";
import { shouldSkipWork } from "../src/agentWork/workItemStateRepository.js";
import { snapshotReviewRunMetrics } from "../src/review/run/reviewRunMetrics.js";
import { requestHeadCiProjection, loadRenderableHeadCi } from "../src/agentWork/ciProjection.js";

const pool = {} as Pool;

function autoReviewItem(overrides: { headSha?: string } = {}): AgentWorkItem {
  return {
    id: "wi-1",
    webhookEventId: "ev-1",
    type: "review",
    source: "auto",
    status: "running",
    owner: "o",
    repo: "r",
    prNumber: 1,
    installationId: 42,
    headSha: overrides.headSha ?? "sha",
    reviewLens: "review",
    resourceKey: "o/r#1",
    attemptCount: 1,
    payload: { mode: "review", source: "auto" },
    cancelRequestedAt: new Date(),
  };
}

function fakeSurface() {
  return createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
}

describe("tryLightweightAutoReviewCompletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(shouldSkipWork).mockResolvedValue(false);
    vi.mocked(snapshotReviewRunMetrics).mockReturnValue(null);
    vi.mocked(loadRenderableHeadCi).mockResolvedValue({
      summary: { status: "pending", headline: "CI is pending", failures: [] },
      version: 1,
    });
  });

  it("does not publish summary when shouldSkipWork is true", async () => {
    vi.mocked(shouldSkipWork).mockResolvedValue(true);
    const { surface, controls } = fakeSurface();

    const result = await tryLightweightAutoReviewCompletion(pool, {
      item: autoReviewItem(),
      reviewLens: "review",
      prSurface: surface,
      model: "grok-4.5",
      leaseEpoch: null,
      preflight: {
        files: [{ filename: "README.md" }],
        truncated: false,
        fileCount: 1,
        totalChanges: 1,
      },
    });

    expect(result).toEqual({
      handled: true,
      published: false,
      reason: "skipped",
    });
    expect(controls.events.filter((event) => event.kind === "upsertProgressComment")).toHaveLength(
      0,
    );
    expect(summaryWrite).not.toHaveBeenCalled();
    expect(recordPublishStep).not.toHaveBeenCalled();
  });

  it("publishes summary when trivial and work is not skipped", async () => {
    const { surface, controls } = fakeSurface();
    const result = await tryLightweightAutoReviewCompletion(pool, {
      item: autoReviewItem(),
      reviewLens: "review",
      prSurface: surface,
      model: "grok-4.5",
      leaseEpoch: null,
      preflight: {
        files: [{ filename: "README.md" }],
        truncated: false,
        fileCount: 1,
        totalChanges: 1,
      },
    });

    expect(result).toMatchObject({ handled: true, published: true });
    expect(summaryWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        progressRevision: 7,
        workItemId: "wi-1",
        resourceKey: "o/r#1",
      }),
    );
    expect(controls.events.some((event) => event.kind === "upsertProgressComment")).toBe(true);
    expect(recordPublishStep).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ step: "summary_comment" }),
    );
    expect(requestHeadCiProjection).toHaveBeenCalled();
  });

  it("writes a terminal lightweight body that replaces the queued stub wording", async () => {
    const { surface, controls } = fakeSurface();
    controls.setProgressComment(
      REVIEW_SUMMARY_SENTINEL,
      `${REVIEW_SUMMARY_SENTINEL}\n\n> [!NOTE]\n> Review queued on the latest commit.\n<!-- pr-agent:progress-revision workItemId=wi-1 value=0 -->`,
      99,
    );
    vi.mocked(getSummaryCommentGithubId).mockResolvedValue(99);

    const result = await tryLightweightAutoReviewCompletion(pool, {
      item: autoReviewItem({ headSha: "5f93e93419cbd32419388cffd90b88804fe6259c" }),
      reviewLens: "review",
      prSurface: surface,
      model: "grok-4.5",
      leaseEpoch: 3,
      preflight: {
        files: [{ filename: "README.md" }],
        truncated: false,
        fileCount: 1,
        totalChanges: 1,
      },
    });

    expect(result).toMatchObject({ handled: true, published: true, summaryId: 99 });
    const upsertArgs = vi.mocked(summaryWrite).mock.calls[0]?.[0];
    expect(upsertArgs?.progressRevision).toBe(7);
    expect(upsertArgs?.hintCommentId).toBe(99);
    expect(upsertArgs?.body).toContain(LIGHTWEIGHT_REVIEW_COMPLETION_LEAD);
    expect(upsertArgs?.body).not.toContain("Review queued on the latest commit.");
    expect(upsertArgs?.body).toContain("<!-- pr-agent:ci-summary");
    expect(upsertArgs?.body).toContain(
      "<!-- pr-agent:review-meta headSha=5f93e93419cbd32419388cffd90b88804fe6259c lens=review stale=false -->",
    );
  });

  it("publishes a 0s footer when metrics snapshot is null", async () => {
    const { surface, controls } = fakeSurface();
    const result = await tryLightweightAutoReviewCompletion(pool, {
      item: autoReviewItem({ headSha: "abc123def456" }),
      reviewLens: "review",
      prSurface: surface,
      model: "grok-4.5",
      leaseEpoch: null,
      preflight: {
        files: [{ filename: "README.md" }],
        truncated: false,
        fileCount: 1,
        totalChanges: 1,
      },
    });

    expect(result).toMatchObject({ handled: true, published: true });
    expect(snapshotReviewRunMetrics).toHaveBeenCalled();
    const upsert = controls.events.find((event) => event.kind === "upsertProgressComment");
    expect(upsert?.kind === "upsertProgressComment" && upsert.body).toContain(
      "<sub>abc123d ⋅ general ⋅ 0s ⋅ grok-4.5</sub>",
    );
  });

  it("uses worker-start metrics for the footer duration and ignores stub post time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T12:10:00.000Z"));
    vi.mocked(snapshotReviewRunMetrics).mockReturnValue({
      startedAtMs: Date.parse("2026-07-22T12:08:00.000Z"),
    } as ReturnType<typeof snapshotReviewRunMetrics>);
    const { surface, controls } = fakeSurface();

    await tryLightweightAutoReviewCompletion(pool, {
      item: autoReviewItem({ headSha: "abc123def456" }),
      reviewLens: "review",
      prSurface: surface,
      model: "grok-4.5",
      leaseEpoch: null,
      preflight: {
        files: [{ filename: "README.md" }],
        truncated: false,
        fileCount: 1,
        totalChanges: 1,
      },
    });

    const upsert = controls.events.find((event) => event.kind === "upsertProgressComment");
    expect(upsert?.kind === "upsertProgressComment" && upsert.body).toContain(
      "<sub>abc123d ⋅ general ⋅ 2m ⋅ grok-4.5</sub>",
    );
    vi.useRealTimers();
  });

  it("uses stored summary id when resolving the progress comment", async () => {
    vi.mocked(getSummaryCommentGithubId).mockResolvedValue(55);
    const { surface, controls } = fakeSurface();
    controls.setProgressComment(REVIEW_SUMMARY_SENTINEL, "existing", 55);

    await tryLightweightAutoReviewCompletion(pool, {
      item: autoReviewItem(),
      reviewLens: "review",
      prSurface: surface,
      model: "grok-4.5",
      leaseEpoch: null,
      preflight: {
        files: [{ filename: "README.md" }],
        truncated: false,
        fileCount: 1,
        totalChanges: 1,
      },
    });

    expect(getSummaryCommentGithubId).toHaveBeenCalledWith(pool, "o/r#1", "review");
    const resolve = controls.events.find((event) => event.kind === "resolveProgressComment");
    expect(resolve).toMatchObject({
      kind: "resolveProgressComment",
      hintCommentId: 55,
    });
    expect(summaryWrite).toHaveBeenCalledWith(expect.objectContaining({ hintCommentId: 55 }));
  });
});
