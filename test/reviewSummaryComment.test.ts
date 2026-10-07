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
import type { Pool, PoolClient } from "pg";
import type { PrSurface } from "../src/github/prSurface.js";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { publishReviewForTest } from "./helpers/reviewPublishTestHelpers.js";
import { REVIEW_SUMMARY_SENTINEL } from "../src/review/reviewSchema.js";
import { renderReviewFailureNotice } from "../src/review/run/progressComment.js";
import { cachedDiffForLines, testPublishState } from "./helpers/reviewPublishTestHelpers.js";
import {
  createPublishReviewTestHarness,
  publishReviewTestBaseParams,
  type PublishReviewTestHarness,
} from "./helpers/publishReviewTestSetup.js";

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

vi.mock("../src/evlog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/evlog.js")>();
  return { ...actual, logWarn: vi.fn() };
});

vi.mock("../src/agentWork/ciProjection.js", () => ({
  loadRenderableHeadCi: vi.fn(async () => ({
    summary: { status: "pending", headline: "⏳ Waiting for CI", failures: [] },
    version: 0,
  })),
  requestHeadCiProjection: vi.fn(async () => "skipped"),
}));

import {
  attachSummaryCommentCoordination,
  createReviewSummaryComment,
} from "../src/review/publish/reviewSummaryComment.js";
import {
  claimSummaryCommentCreation,
  getProgressCommentOwner,
  getProgressCommentRevision,
  getProgressStubPostedAtMs,
  getSummaryCommentGithubId,
} from "../src/agentWork/publishRecordRepository.js";
import { logWarn } from "../src/evlog.js";
import { withSessionLock } from "../src/db/sessionLock.js";
import {
  availableInstallationCapabilities,
  createReviewCapabilityPolicy,
} from "../src/github/installationCapabilities.js";

let harness: PublishReviewTestHarness;
let baseParams: ReturnType<typeof publishReviewTestBaseParams>;

it("renders one concise optional-capability notice without changing review output", async () => {
  const bundle = createPublishReviewTestHarness();
  const observation = availableInstallationCapabilities({
    appId: 1,
    installationId: 42,
    owner: "o",
    repo: "r",
  });
  Object.assign(bundle.surface, {
    capabilities: createReviewCapabilityPolicy({
      ...observation,
      availability: {
        ...observation.availability,
        checksRead: "denied",
        checksWrite: "denied",
        actionsRead: "unknown",
        labelsWrite: "denied",
      },
    }),
  });
  await createReviewSummaryComment({ prSurface: bundle.surface, reviewLens: "review" }).conclude({
    body: "review output",
  });
  const body = bundle.upsertProgressComment.mock.calls[0]?.[0] ?? "";
  expect(body).toContain("review output");
  expect(body).toContain("<summary>Limited permissions</summary>");
  expect(body).toContain("- Checks read/write\n- Actions logs\n- labels\n");
  expect(body.match(/Unavailable for this review:/g)).toHaveLength(1);
});

function createLockedPool() {
  const query = vi.fn(
    async (
      _sql: string,
      _values?: unknown[],
    ): Promise<{ rows: { locked: boolean; unlocked?: boolean }[] }> => ({
      rows: [{ locked: true, unlocked: true }],
    }),
  );
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  const pool = {
    options: { max: 4 },
    connect: vi.fn(async () => client),
  } as unknown as Pool;
  return { client, pool, query, release };
}

const { pool, query: lockQuery } = createLockedPool();

function claimBase() {
  return {
    pool,
    workItemId: "wi-1",
    resourceKey: "o/r#1",
    reviewLens: "review" as const,
    prSurface: harness.surface,
    body: "summary body",
  };
}

function writeSummary(params: {
  readonly pool: Pool;
  readonly workItemId?: string;
  readonly resourceKey: string;
  readonly reviewLens: "review";
  readonly prSurface: PrSurface;
  readonly body: string;
  readonly progressRevision: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
  readonly hintCommentId?: number | null;
  readonly shouldPublish?: (client: PoolClient) => Promise<boolean>;
}) {
  const summary = createReviewSummaryComment({
    prSurface: params.prSurface,
    reviewLens: params.reviewLens,
    coordination: {
      pool: params.pool,
      resourceKey: params.resourceKey,
      workItemId: params.workItemId,
    },
  });
  const { body, hintCommentId } = params;
  return params.progressRevision === 7
    ? summary.conclude({ body, hintCommentId })
    : summary.tick({
        body,
        hintCommentId,
        progressRevision: params.progressRevision,
        shouldPublish: params.shouldPublish,
      });
}

describe("createReviewSummaryComment", () => {
  beforeEach(() => {
    harness = createPublishReviewTestHarness();
    vi.clearAllMocks();
    vi.mocked(getProgressCommentOwner).mockResolvedValue(null);
    vi.mocked(getProgressCommentRevision).mockResolvedValue(null);
    vi.mocked(getProgressStubPostedAtMs).mockResolvedValue(null);
    vi.mocked(getSummaryCommentGithubId).mockResolvedValue(null);
    vi.mocked(claimSummaryCommentCreation).mockResolvedValue(true);
    harness.resolveProgressComment.mockResolvedValue(null);
    harness.findProgressComment.mockResolvedValue(null);
    harness.upsertProgressComment.mockResolvedValue({ id: 99, updated: false });
  });

  it("creates when claim won and no stored id", async () => {
    const { client, pool: lockedPool } = createLockedPool();
    await writeSummary({ ...claimBase(), pool: lockedPool, progressRevision: 2 });

    expect(claimSummaryCommentCreation).toHaveBeenCalledWith(client, "wi-1", "o/r#1", "review");
    expect(harness.findProgressComment).toHaveBeenCalledTimes(2);
    expect(harness.upsertProgressComment).toHaveBeenCalledWith(
      expect.stringContaining("summary body"),
      REVIEW_SUMMARY_SENTINEL,
      null,
    );
  });

  it("uses stored id without scanning when verified", async () => {
    const { pool: lockedPool } = createLockedPool();
    vi.mocked(getSummaryCommentGithubId).mockResolvedValue(55);
    harness.resolveProgressComment.mockResolvedValue({
      id: 55,
      url: "https://example.com/55",
    });

    await writeSummary({ ...claimBase(), pool: lockedPool, progressRevision: 2 });

    expect(claimSummaryCommentCreation).not.toHaveBeenCalled();
    expect(harness.findProgressComment).toHaveBeenCalledTimes(1);
    expect(harness.upsertProgressComment).toHaveBeenCalledWith(
      expect.stringContaining("summary body"),
      REVIEW_SUMMARY_SENTINEL,
      { id: 55, url: "https://example.com/55" },
    );
  });

  it("updates polled id when claim lost", async () => {
    const { pool: lockedPool } = createLockedPool();
    vi.useFakeTimers();
    vi.mocked(claimSummaryCommentCreation).mockResolvedValue(false);
    vi.mocked(getSummaryCommentGithubId).mockResolvedValueOnce(null).mockResolvedValueOnce(77);
    harness.resolveProgressComment.mockResolvedValue({
      id: 77,
      url: "https://example.com/77",
    });

    const pending = writeSummary({ ...claimBase(), pool: lockedPool, progressRevision: 2 });
    await vi.advanceTimersByTimeAsync(1_500);
    await pending;

    expect(getSummaryCommentGithubId).toHaveBeenCalled();
    expect(harness.findProgressComment).toHaveBeenCalledTimes(1);
    expect(harness.upsertProgressComment).toHaveBeenCalledWith(
      expect.stringContaining("summary body"),
      REVIEW_SUMMARY_SENTINEL,
      { id: 77, url: "https://example.com/77" },
    );
    vi.useRealTimers();
  });

  it("creates as last resort when claim lost and poll misses", async () => {
    const { pool: lockedPool } = createLockedPool();
    vi.useFakeTimers();
    vi.mocked(claimSummaryCommentCreation).mockResolvedValue(false);
    harness.findProgressComment.mockResolvedValue(null);

    const pending = writeSummary({ ...claimBase(), pool: lockedPool, progressRevision: 2 });
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;

    expect(harness.findProgressComment).toHaveBeenCalledTimes(2);
    expect(harness.upsertProgressComment).toHaveBeenCalledWith(
      expect.stringContaining("summary body"),
      REVIEW_SUMMARY_SENTINEL,
      null,
    );
    vi.useRealTimers();
  });

  it("writes a failure notice under the lock with a terminal revision marker", async () => {
    const { client, pool: lockedPool, query } = createLockedPool();
    harness.findProgressComment.mockResolvedValue({
      id: 88,
      url: "https://example.com/88",
      body: `${REVIEW_SUMMARY_SENTINEL}\n<!-- pr-agent:progress-revision workItemId=wi-1 value=3 -->`,
    });
    vi.mocked(getProgressCommentRevision).mockResolvedValue({ workItemId: "wi-1", revision: 3 });

    await createReviewSummaryComment({
      prSurface: harness.surface,
      reviewLens: "review",
      coordination: { pool: lockedPool, resourceKey: "o/r#1", workItemId: "wi-1" },
    }).conclude({ body: renderReviewFailureNotice({ mode: "review", retryCommand: "/review" }) });

    expect(query.mock.calls[0]?.[0]).toContain("pg_try_advisory_lock");
    expect(harness.upsertProgressComment).toHaveBeenCalledWith(
      expect.stringMatching(/Review did not finish[\s\S]*workItemId=wi-1 value=7 -->$/),
      REVIEW_SUMMARY_SENTINEL,
      expect.objectContaining({ id: 88, url: "https://example.com/88" }),
    );
    expect(recordPublishStep).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        step: "progress_comment",
        detail: expect.objectContaining({ progressRevision: 7 }),
      }),
    );
  });

  it("does not let a failure notice replace a newer work item's progress", async () => {
    const { pool: lockedPool } = createLockedPool();
    vi.mocked(getProgressCommentOwner).mockResolvedValue({ workItemId: "wi-b", generation: 2 });
    harness.findProgressComment.mockResolvedValue({
      id: 88,
      url: "https://example.com/88",
      body: `${REVIEW_SUMMARY_SENTINEL}\n<!-- pr-agent:progress-revision workItemId=wi-b value=1 -->`,
    });

    await expect(
      createReviewSummaryComment({
        prSurface: harness.surface,
        reviewLens: "review",
        coordination: { pool: lockedPool, resourceKey: "o/r#1", workItemId: "wi-a" },
      }).conclude({ body: renderReviewFailureNotice({ mode: "review", retryCommand: "/review" }) }),
    ).resolves.toMatchObject({ id: 88, skipped: true });

    expect(harness.upsertProgressComment).not.toHaveBeenCalled();
  });

  it("writes straight to the surface when there is no coordination", async () => {
    await createReviewSummaryComment({
      prSurface: harness.surface,
      reviewLens: "review",
    }).conclude({ body: "summary body", knownExisting: { id: 5, url: "https://example.com/5" } });

    expect(harness.upsertProgressComment).toHaveBeenCalledWith(
      "summary body",
      REVIEW_SUMMARY_SENTINEL,
      { id: 5, url: "https://example.com/5" },
    );
    expect(harness.findProgressComment).not.toHaveBeenCalled();
    expect(recordPublishStep).not.toHaveBeenCalled();
  });

  it("does not let a delayed specialist tick overwrite the final summary", async () => {
    const { pool: lockedPool, query, release } = createLockedPool();
    vi.mocked(getProgressCommentRevision).mockResolvedValue({ workItemId: "wi-1", revision: 5 });
    harness.findProgressComment.mockResolvedValue({
      id: 88,
      url: "https://example.com/88",
      body: `${REVIEW_SUMMARY_SENTINEL}\n\nfinal\n<!-- pr-agent:progress-revision workItemId=wi-1 value=6 -->`,
    });

    await expect(
      writeSummary({
        ...claimBase(),
        pool: lockedPool,
        progressRevision: 1,
      }),
    ).resolves.toEqual({ id: 88, updated: false, skipped: true });

    expect(harness.upsertProgressComment).not.toHaveBeenCalled();
    expect(recordPublishStep).not.toHaveBeenCalled();
    expect(query.mock.calls[0]?.[0]).toContain("pg_try_advisory_lock");
    expect(query.mock.calls.at(-1)?.[0]).toContain("pg_advisory_unlock");
    expect(release).toHaveBeenCalledOnce();
  });

  it("uses a stable NUL-free advisory lock key", async () => {
    const { pool: lockedPool, query } = createLockedPool();
    vi.mocked(getProgressCommentRevision).mockResolvedValue({ workItemId: "wi-1", revision: 5 });
    harness.findProgressComment.mockResolvedValue({
      id: 88,
      url: "https://example.com/88",
      body: `${REVIEW_SUMMARY_SENTINEL}\n<!-- pr-agent:progress-revision workItemId=wi-1 value=6 -->`,
    });

    await writeSummary({
      ...claimBase(),
      pool: lockedPool,
      progressRevision: 1,
    });

    const lockKey = query.mock.calls[0]?.[1]?.[0];
    expect(lockKey).toBe(JSON.stringify(["o/r#1", "review"]));
    expect(lockKey).not.toContain("\u0000");
  });

  it("records stubPostedAtMs on revision 0 and preserves it on later ticks", async () => {
    const { pool: lockedPool } = createLockedPool();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T12:00:00.000Z"));

    await writeSummary({
      ...claimBase(),
      pool: lockedPool,
      progressRevision: 0,
    });

    expect(recordPublishStep).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        step: "progress_comment",
        detail: expect.objectContaining({
          progressRevision: 0,
          stubPostedAtMs: Date.parse("2026-07-22T12:00:00.000Z"),
        }),
      }),
    );

    const stubPostedAtMs = Date.parse("2026-07-22T12:00:00.000Z");
    vi.mocked(getProgressCommentRevision).mockResolvedValue({ workItemId: "wi-1", revision: 0 });
    vi.mocked(getProgressStubPostedAtMs).mockResolvedValue(stubPostedAtMs);
    harness.findProgressComment.mockResolvedValue({
      id: 99,
      url: "https://example.com/99",
      body: `${REVIEW_SUMMARY_SENTINEL}\n<!-- pr-agent:progress-revision workItemId=wi-1 value=0 -->`,
    });
    vi.setSystemTime(new Date("2026-07-22T12:05:00.000Z"));

    await writeSummary({
      ...claimBase(),
      pool: lockedPool,
      progressRevision: 2,
    });

    expect(recordPublishStep).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        step: "progress_comment",
        detail: {
          progressRevision: 2,
          updated: false,
          stubPostedAtMs,
        },
      }),
    );
    vi.useRealTimers();
  });

  it("does not copy a prior CI cell when the next body omits CI", async () => {
    const { pool: lockedPool } = createLockedPool();
    const priorBody = [
      REVIEW_SUMMARY_SENTINEL,
      "",
      "<table>",
      "<tbody>",
      "<tr><td><strong>Head</strong></td><td><code>abc</code></td></tr>",
      "<tr><td><strong>Source</strong></td><td>Pull request update</td></tr>",
      "<tr><td><strong>CI</strong></td><td><!-- pr-agent:ci-summary -->⏳ CI is still running<!-- /pr-agent:ci-summary --></td></tr>",
      "<tr><td><strong>Recon</strong></td><td>⏳ Running</td></tr>",
      "</tbody>",
      "</table>",
      "<!-- pr-agent:progress-revision workItemId=wi-1 value=0 -->",
    ].join("\n");
    const nextBody = [
      REVIEW_SUMMARY_SENTINEL,
      "",
      "<table>",
      "<tbody>",
      "<tr><td><strong>Head</strong></td><td><code>abc</code></td></tr>",
      "<tr><td><strong>Source</strong></td><td>Pull request update</td></tr>",
      "<tr><td><strong>Recon</strong></td><td>✅ Done</td></tr>",
      "</tbody>",
      "</table>",
    ].join("\n");

    vi.mocked(getProgressCommentRevision).mockResolvedValue({ workItemId: "wi-1", revision: 0 });
    harness.findProgressComment.mockResolvedValue({
      id: 88,
      url: "https://example.com/88",
      body: priorBody,
    });

    await writeSummary({
      ...claimBase(),
      pool: lockedPool,
      body: nextBody,
      progressRevision: 1,
    });

    const writtenBody = harness.upsertProgressComment.mock.calls[0]?.[0];
    expect(writtenBody).not.toContain("<strong>CI</strong>");
    expect(writtenBody).not.toContain("CI is still running");
    expect(writtenBody).toContain("<strong>Recon</strong>");
  });

  it("allows a new work item to restart progress at revision zero", async () => {
    const { pool: lockedPool } = createLockedPool();
    vi.mocked(getProgressCommentOwner).mockResolvedValue({
      workItemId: "wi-1",
      generation: 1,
    });
    vi.mocked(getProgressCommentRevision).mockResolvedValue({
      workItemId: "wi-old",
      revision: 5,
    });
    harness.findProgressComment.mockResolvedValue({
      id: 88,
      url: "https://example.com/88",
      body: `${REVIEW_SUMMARY_SENTINEL}\n<!-- pr-agent:progress-revision workItemId=wi-old value=6 -->`,
    });
    harness.resolveProgressComment.mockResolvedValue({
      id: 88,
      url: "https://example.com/88",
    });

    await expect(
      writeSummary({
        ...claimBase(),
        pool: lockedPool,
        progressRevision: 0,
      }),
    ).resolves.toMatchObject({ id: 99 });

    expect(harness.upsertProgressComment).toHaveBeenCalledWith(
      expect.stringContaining("workItemId=wi-1 value=0"),
      REVIEW_SUMMARY_SENTINEL,
      { id: 88, url: "https://example.com/88" },
    );
  });

  it("skips summary upsert when another work item owns the progress record", async () => {
    const { pool: lockedPool } = createLockedPool();
    vi.mocked(getProgressCommentOwner).mockResolvedValue({
      workItemId: "wi-b",
      generation: 2,
    });
    harness.findProgressComment.mockResolvedValue({
      id: 88,
      url: "https://example.com/88",
      body: `${REVIEW_SUMMARY_SENTINEL}\n<!-- pr-agent:progress-revision workItemId=wi-b value=1 -->`,
    });

    await expect(
      writeSummary({
        ...claimBase(),
        pool: lockedPool,
        workItemId: "wi-a",
        progressRevision: 0,
      }),
    ).resolves.toMatchObject({ id: 88, updated: false, skipped: true });

    expect(harness.upsertProgressComment).not.toHaveBeenCalled();
  });

  it("recovers from a crash after the GitHub write using the body revision marker", async () => {
    const { pool: lockedPool, release } = createLockedPool();
    vi.mocked(getProgressCommentRevision).mockResolvedValue(null);
    harness.findProgressComment.mockResolvedValue(null);
    vi.mocked(recordPublishStep)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("record failed"));

    await expect(
      writeSummary({
        ...claimBase(),
        pool: lockedPool,
        progressRevision: 2,
      }),
    ).rejects.toThrow("record failed");

    const writtenBody = harness.upsertProgressComment.mock.calls[0]?.[0];
    expect(writtenBody).toContain("workItemId=wi-1 value=2");
    harness.findProgressComment.mockResolvedValue({
      id: 99,
      url: "https://example.com/99",
      body: writtenBody ?? "",
    });

    await expect(
      writeSummary({
        ...claimBase(),
        pool: lockedPool,
        progressRevision: 2,
      }),
    ).resolves.toEqual({ id: 99, updated: false, skipped: true });

    expect(harness.upsertProgressComment).toHaveBeenCalledOnce();
    expect(recordPublishStep).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("retries after a claim recorded under the lock but before the GitHub write", async () => {
    const { pool: lockedPool } = createLockedPool();
    vi.mocked(getProgressCommentRevision).mockResolvedValue({ workItemId: "wi-1", revision: 2 });
    harness.findProgressComment.mockResolvedValue({
      id: 88,
      url: "https://example.com/88",
      body: `${REVIEW_SUMMARY_SENTINEL}\nno revision marker yet`,
    });

    const result = await writeSummary({
      ...claimBase(),
      pool: lockedPool,
      progressRevision: 2,
    });

    expect(result).toEqual({ id: 99, updated: false });
    const writtenBody = harness.upsertProgressComment.mock.calls[0]?.[0];
    expect(writtenBody).toContain("workItemId=wi-1 value=2");
  });

  it("logs the foreign-owner warning only without a comment or hint", async () => {
    const { pool: lockedPool } = createLockedPool();
    vi.mocked(getProgressCommentOwner).mockResolvedValue({
      workItemId: "wi-b",
      generation: 2,
    });
    harness.findProgressComment.mockResolvedValue(null);

    await expect(
      writeSummary({
        ...claimBase(),
        pool: lockedPool,
        workItemId: "wi-a",
        progressRevision: 0,
      }),
    ).resolves.toEqual({ id: 0, updated: false, skipped: true });

    expect(logWarn).toHaveBeenCalledWith(
      "review_progress_skipped_foreign_owner",
      expect.objectContaining({ ownerWorkItemId: "wi-b" }),
    );

    vi.mocked(logWarn).mockClear();
    harness.findProgressComment.mockResolvedValue({
      id: 88,
      url: "https://example.com/88",
      body: `${REVIEW_SUMMARY_SENTINEL}\n<!-- pr-agent:progress-revision workItemId=wi-b value=1 -->`,
    });

    await expect(
      writeSummary({
        ...claimBase(),
        pool: lockedPool,
        workItemId: "wi-a",
        progressRevision: 0,
      }),
    ).resolves.toMatchObject({ id: 88, updated: false, skipped: true });

    expect(logWarn).not.toHaveBeenCalledWith(
      "review_progress_skipped_foreign_owner",
      expect.anything(),
    );
  });

  it("records a revision after the GitHub upsert and unlocks on failure", async () => {
    const { client, pool: lockedPool, query, release } = createLockedPool();
    vi.mocked(getProgressCommentRevision).mockResolvedValue({ workItemId: "wi-1", revision: 0 });
    harness.findProgressComment.mockResolvedValue({
      id: 88,
      url: "https://example.com/88",
      body: `${REVIEW_SUMMARY_SENTINEL}\n<!-- pr-agent:progress-revision workItemId=wi-1 value=0 -->`,
    });
    harness.upsertProgressComment.mockRejectedValueOnce(new Error("write failed"));

    await expect(
      writeSummary({
        ...claimBase(),
        pool: lockedPool,
        progressRevision: 2,
      }),
    ).rejects.toThrow("write failed");

    expect(getProgressCommentRevision).toHaveBeenCalledWith(client, "o/r#1", "review");
    expect(recordPublishStep).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        step: "progress_comment",
        detail: expect.objectContaining({ progressRevision: 2 }),
      }),
    );
    expect(query.mock.calls.at(-1)?.[0]).toContain("pg_advisory_unlock");
    expect(release).toHaveBeenCalledOnce();
  });

  it("holds the progress lock through the fresh read, GitHub write, and record", async () => {
    const { client, query, release } = createLockedPool();
    const order: string[] = [];
    const pool = {
      options: { max: 4 },
      connect: vi.fn(async () => {
        order.push("connect");
        return client;
      }),
    } as unknown as Pool;
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("pg_try_advisory_lock")) order.push("lock");
      if (sql.includes("pg_advisory_unlock")) order.push("unlock");
      return { rows: [{ locked: true, unlocked: true }] };
    });
    release.mockImplementation(() => {
      order.push("release");
    });
    harness.findProgressComment.mockImplementation(async () => {
      order.push("find");
      return {
        id: 88,
        url: "https://example.com/88",
        body: `${REVIEW_SUMMARY_SENTINEL}\n<!-- pr-agent:progress-revision workItemId=wi-1 value=0 -->`,
      };
    });
    harness.resolveProgressComment.mockImplementation(async () => {
      order.push("resolve");
      return { id: 88, url: "https://example.com/88" };
    });
    harness.upsertProgressComment.mockImplementation(async () => {
      order.push("upsert");
      return { id: 88, updated: true };
    });
    vi.mocked(recordPublishStep).mockImplementation(async () => {
      order.push("record");
    });

    await writeSummary({
      ...claimBase(),
      pool,
      progressRevision: 2,
    });

    expect(order.indexOf("find")).toBeGreaterThan(-1);
    expect(order.indexOf("lock")).toBeLessThan(order.indexOf("find"));
    expect(order.indexOf("find")).toBeLessThan(order.indexOf("resolve"));
    expect(order.indexOf("upsert")).toBeLessThan(order.lastIndexOf("record"));
    expect(order.lastIndexOf("record")).toBeLessThan(order.indexOf("unlock"));
    expect(order.indexOf("unlock")).toBeLessThan(order.indexOf("release"));
    expect(recordPublishStep).toHaveBeenLastCalledWith(client, expect.anything());
  });

  it("releases contended clients before retrying and preserves publication", async () => {
    const { pool: lockedPool, query, release } = createLockedPool();
    query.mockResolvedValueOnce({ rows: [{ locked: false }] });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const pending = writeSummary({
        ...claimBase(),
        pool: lockedPool,
        progressRevision: 2,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(release).toHaveBeenCalledOnce();
      expect(harness.upsertProgressComment).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toEqual({ id: 99, updated: false });
      expect(release).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["read", "write", "record"] as const)(
    "releases publication capacity after a %s failure without asserting nonacceptance",
    async (stage) => {
      const { pool: lockedPool, release } = createLockedPool();
      const error = new Error(`${stage} failed`);
      if (stage === "read") harness.findProgressComment.mockRejectedValueOnce(error);
      if (stage === "write") harness.upsertProgressComment.mockRejectedValueOnce(error);
      if (stage === "record") {
        vi.mocked(recordPublishStep).mockResolvedValueOnce(undefined).mockRejectedValueOnce(error);
      }
      await expect(
        writeSummary({
          ...claimBase(),
          pool: lockedPool,
          progressRevision: 2,
        }),
      ).rejects.toBe(error);
      expect(error).not.toHaveProperty("mutationAccepted");
      expect(release).toHaveBeenCalledOnce();
      await expect(
        writeSummary({
          ...claimBase(),
          pool: lockedPool,
          progressRevision: 2,
        }),
      ).resolves.toMatchObject({ id: 99 });
    },
  );

  it("discards a client that connects after the acquisition budget", async () => {
    const { pool: lockedPool, client, release } = createLockedPool();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    let completeCheckout = (_client: PoolClient) => {};
    vi.mocked(lockedPool.connect).mockImplementationOnce(
      () =>
        new Promise<PoolClient>((resolve) => {
          completeCheckout = resolve;
        }),
    );
    try {
      const pending = writeSummary({
        ...claimBase(),
        pool: lockedPool,
        progressRevision: 2,
      }).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10_001);
      completeCheckout(client);
      expect(await pending).toMatchObject({ mutationAccepted: false });
      expect(release).toHaveBeenCalledWith(true);
      expect(harness.upsertProgressComment).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks checkout failure as nonaccepted and restores capacity", async () => {
    const { pool: lockedPool } = createLockedPool();
    vi.mocked(lockedPool.connect).mockRejectedValueOnce(new Error("connect failed"));
    await expect(
      writeSummary({
        ...claimBase(),
        pool: lockedPool,
        progressRevision: 2,
      }),
    ).rejects.toMatchObject({ mutationAccepted: false });
    await expect(
      writeSummary({
        ...claimBase(),
        pool: lockedPool,
        progressRevision: 2,
      }),
    ).resolves.toMatchObject({ id: 99 });
  });

  it("marks contention exhaustion as not accepted and frees capacity for a retry", async () => {
    const { pool: lockedPool, query } = createLockedPool();
    query.mockResolvedValue({ rows: [{ locked: false }] });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const pending = writeSummary({
        ...claimBase(),
        pool: lockedPool,
        progressRevision: 2,
      }).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await pending).toMatchObject({
        code: "review.progress_lock_timeout",
        mutationAccepted: false,
      });
      expect(harness.upsertProgressComment).not.toHaveBeenCalled();
      query.mockResolvedValue({ rows: [{ locked: true, unlocked: true }] });
      await expect(
        writeSummary({
          ...claimBase(),
          pool: lockedPool,
          progressRevision: 2,
        }),
      ).resolves.toMatchObject({ id: 99 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects insufficient pool capacity before any comment mutation", async () => {
    const { pool: lockedPool } = createLockedPool();
    lockedPool.options.max = 1;
    await expect(
      writeSummary({
        ...claimBase(),
        pool: lockedPool,
        progressRevision: 2,
      }),
    ).rejects.toMatchObject({
      code: "review.progress_lock_capacity",
      mutationAccepted: false,
    });
    expect(lockedPool.connect).not.toHaveBeenCalled();
    expect(harness.upsertProgressComment).not.toHaveBeenCalled();
  });

  it("shares half-pool admission between progress and own verdict without checkout on deferral", async () => {
    const { withOwnVerdictClose } = await vi.importActual<
      typeof import("../src/agentWork/publishRecordRepository.js")
    >("../src/agentWork/publishRecordRepository.js");
    const { pool: lockedPool } = createLockedPool();
    lockedPool.options.max = 2;
    let resume!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    harness.findProgressComment.mockImplementationOnce(async () => {
      entered();
      await gate;
      return null;
    });
    const progress = writeSummary({
      ...claimBase(),
      pool: lockedPool,
      progressRevision: 2,
    });
    try {
      await ready;
      const apply = vi.fn(async () => true);
      await expect(
        withOwnVerdictClose(
          lockedPool,
          { workItemId: "wi-1", resourceKey: "o/r#1", reviewLens: "review" },
          apply,
        ),
      ).resolves.toBeUndefined();
      expect(apply).not.toHaveBeenCalled();
      expect(lockedPool.connect).toHaveBeenCalledOnce();
    } finally {
      resume();
      await progress;
    }
    await expect(
      withOwnVerdictClose(
        lockedPool,
        { workItemId: "wi-1", resourceKey: "o/r#1", reviewLens: "review" },
        async () => true,
      ),
    ).resolves.toBe(true);
  });

  it("owns odd-pool admission across typed lock families and bounds waiting without checkout", async () => {
    const { pool: lockedPool, query, release } = createLockedPool();
    lockedPool.options.max = 5;
    const capacityError = () => new Error("insufficient capacity");
    const timeoutError = new Error("wait timed out");
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const holders: Promise<unknown>[] = [];
    try {
      holders.push(
        withSessionLock(
          lockedPool,
          { kind: "own_verdict", workItemId: "wi-1", reviewLens: "review" },
          { mode: "try", unleased: true, capacityError, onContended: async () => undefined },
          async () => gate,
        ),
      );
      holders.push(
        withSessionLock(
          lockedPool,
          { kind: "progress", resourceKey: "o/r#1", reviewLens: "review" },
          {
            mode: "wait",
            deadline: performance.now() + 10_000,
            capacityError,
            timeoutError,
            onAcquireError: (error) => {
              throw error;
            },
            onUnlockError: () => {},
          },
          async () => gate,
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(lockedPool.connect).toHaveBeenCalledTimes(2);
      expect(query.mock.calls.map(([, values]) => values)).toEqual([
        ["own-verdict:wi-1:review"],
        [JSON.stringify(["o/r#1", "review"])],
      ]);
      const apply = vi.fn(async () => true);
      const onContended = vi.fn(async () => undefined);
      await expect(
        withSessionLock(
          lockedPool,
          { kind: "own_verdict", workItemId: "wi-2", reviewLens: "review" },
          { mode: "try", unleased: true, capacityError, onContended },
          apply,
        ),
      ).resolves.toBeUndefined();
      expect(onContended).not.toHaveBeenCalled();
      const waiting = withSessionLock(
        lockedPool,
        { kind: "progress", resourceKey: "o/r#2", reviewLens: "review" },
        {
          mode: "wait",
          deadline: performance.now() + 10_000,
          capacityError,
          timeoutError,
          onAcquireError: (error) => {
            throw error;
          },
          onUnlockError: () => {},
        },
        apply,
      ).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await waiting).toBe(timeoutError);
      expect(apply).not.toHaveBeenCalled();
      expect(lockedPool.connect).toHaveBeenCalledTimes(2);
      expect(release).not.toHaveBeenCalled();
    } finally {
      resume();
      await Promise.all(holders);
      vi.useRealTimers();
    }
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("destroys a progress session when unlock returns false", async () => {
    const { pool: lockedPool, query, release } = createLockedPool();
    query
      .mockResolvedValueOnce({ rows: [{ locked: true }] })
      .mockResolvedValueOnce({ rows: [{ locked: false, unlocked: false }] });
    await expect(
      writeSummary({
        ...claimBase(),
        pool: lockedPool,
        progressRevision: 2,
      }),
    ).resolves.toMatchObject({ id: 99 });
    expect(release).toHaveBeenCalledWith(true);
  });

  it("releases the client when advisory lock acquisition fails", async () => {
    const { pool: lockedPool, query, release } = createLockedPool();
    query.mockRejectedValueOnce(new Error("lock failed"));

    await expect(
      writeSummary({
        ...claimBase(),
        pool: lockedPool,
        progressRevision: 1,
      }),
    ).rejects.toMatchObject({
      code: "review.progress_lock_failed",
      mutationAccepted: false,
      cause: expect.objectContaining({ message: "lock failed" }),
    });

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain("pg_try_advisory_lock");
    expect(release).toHaveBeenCalledWith(true);
    await expect(
      writeSummary({
        ...claimBase(),
        pool: lockedPool,
        progressRevision: 1,
      }),
    ).resolves.toMatchObject({ id: 99 });
  });

  it("destroys the client and surfaces an unlock-only failure", async () => {
    const { pool: lockedPool, query, release } = createLockedPool();
    query
      .mockResolvedValueOnce({ rows: [{ locked: true }] })
      .mockRejectedValueOnce(new Error("unlock failed"));
    vi.mocked(getProgressCommentRevision).mockResolvedValue({ workItemId: "wi-1", revision: 5 });
    harness.findProgressComment.mockResolvedValue({
      id: 88,
      url: "https://example.com/88",
      body: `${REVIEW_SUMMARY_SENTINEL}\n<!-- pr-agent:progress-revision workItemId=wi-1 value=6 -->`,
    });

    await expect(
      writeSummary({
        ...claimBase(),
        pool: lockedPool,
        progressRevision: 1,
      }),
    ).rejects.toThrow("unlock failed");

    expect(release).toHaveBeenCalledWith(true);
    expect(logWarn).toHaveBeenCalledWith(
      "review_progress_unlock_failed",
      expect.objectContaining({ resourceKey: "o/r#1", reviewLens: "review" }),
    );
  });

  it("preserves the operation error when unlock also fails", async () => {
    const { pool: lockedPool, query, release } = createLockedPool();
    query
      .mockResolvedValueOnce({ rows: [{ locked: true }] })
      .mockRejectedValueOnce(new Error("unlock failed"));
    vi.mocked(getProgressCommentRevision).mockRejectedValueOnce(new Error("operation failed"));

    await expect(
      writeSummary({
        ...claimBase(),
        pool: lockedPool,
        progressRevision: 1,
      }),
    ).rejects.toThrow("operation failed");

    expect(release).toHaveBeenCalledWith(true);
    expect(logWarn).toHaveBeenCalledWith(
      "review_progress_unlock_failed",
      expect.objectContaining({ message: "unlock failed" }),
    );
  });

  it("preserves the operation error and restores capacity when release fails", async () => {
    const { pool: lockedPool, release } = createLockedPool();
    const primary = new Error("upsert failed");
    harness.upsertProgressComment.mockRejectedValueOnce(primary);
    release.mockImplementationOnce(() => {
      throw new Error("release failed");
    });
    await expect(
      writeSummary({
        ...claimBase(),
        pool: lockedPool,
        progressRevision: 2,
      }),
    ).rejects.toBe(primary);
    await expect(
      writeSummary({
        ...claimBase(),
        pool: lockedPool,
        progressRevision: 2,
      }),
    ).resolves.toMatchObject({ id: 99 });
  });
});

describe("publishReview summary coordination", () => {
  beforeEach(() => {
    harness = createPublishReviewTestHarness();
    baseParams = publishReviewTestBaseParams(harness);
    vi.clearAllMocks();
    vi.mocked(getProgressCommentRevision).mockResolvedValue(null);
    vi.mocked(getSummaryCommentGithubId).mockResolvedValue(88);
    vi.mocked(claimSummaryCommentCreation).mockResolvedValue(true);
    harness.resolveProgressComment.mockResolvedValue({
      id: 88,
      url: "https://example.com/88",
    });
    harness.upsertProgressComment.mockResolvedValue({ id: 88, updated: true });
  });

  it("publishes the final summary at terminal progress revision under the progress lock", async () => {
    const recordPublishStep = attachSummaryCommentCoordination(vi.fn(), {
      pool,
      workItemId: "wi-1",
      resourceKey: "o/r#1",
    });

    await publishReviewForTest({
      ...baseParams,
      publishState: testPublishState(),
      cachedDiffIndex: cachedDiffForLines("src/x.ts", [4]),
      recordPublishStep,
    });

    expect(harness.findProgressComment).toHaveBeenCalled();
    expect(harness.upsertProgressComment).toHaveBeenCalledWith(
      expect.stringContaining("<!-- pr-agent:progress-revision workItemId=wi-1 value=7 -->"),
      REVIEW_SUMMARY_SENTINEL,
      { id: 88, url: "https://example.com/88" },
    );
    expect(lockQuery.mock.calls.some(([sql]) => sql.includes("pg_try_advisory_lock"))).toBe(true);
    expect(lockQuery.mock.calls.some(([sql]) => sql.includes("pg_advisory_unlock"))).toBe(true);
  });
});
