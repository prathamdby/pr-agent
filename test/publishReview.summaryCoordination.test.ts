import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { publishReviewForTest } from "./helpers/reviewPublishTestHelpers.js";
import { REVIEW_SUMMARY_SENTINEL } from "../src/review/reviewSchema.js";
import { cachedDiffForLines, testPublishState } from "./helpers/reviewPublishTestHelpers.js";
import { publishReviewTestBaseParams } from "./helpers/publishReviewTestSetup.js";

vi.mock("../src/github/reviewPublish.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/github/reviewPublish.js")>();
  const { createReviewPublishGithubMock } = await import("./helpers/publishReviewTestSetup.js");
  return createReviewPublishGithubMock(actual);
});

vi.mock("../src/agentWork/repository.js", async () => {
  const { createAgentWorkRepositoryMock } = await import("./helpers/publishReviewTestSetup.js");
  return createAgentWorkRepositoryMock();
});

vi.mock("../src/agentWork/reviewCheckRun.js", async () => {
  const { createReviewCheckRunMock } = await import("./helpers/publishReviewTestSetup.js");
  return createReviewCheckRunMock();
});

vi.mock("../src/evlog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/evlog.js")>();
  return { ...actual, logWarn: vi.fn() };
});

import {
  findIssueCommentBySentinel,
  resolveVerifiedSummaryCommentRef,
  upsertReviewSummaryComment,
} from "../src/github/reviewPublish.js";
import {
  attachSummaryCommentCoordination,
  upsertSummaryCommentWithCreationClaim,
} from "../src/review/publish/publishReview.js";
import {
  claimSummaryCommentCreation,
  getProgressCommentOwner,
  getProgressCommentRevision,
  getProgressStubPostedAtMs,
  getSummaryCommentGithubId,
  recordPublishStep,
} from "../src/agentWork/repository.js";
import { logWarn } from "../src/evlog.js";

const baseParams = publishReviewTestBaseParams;

function createLockedPool() {
  const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [] }));
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  return { client, pool, query, release };
}

const { pool, query: lockQuery } = createLockedPool();
const claimBase = {
  pool,
  workItemId: "wi-1",
  resourceKey: "o/r#1",
  reviewLens: "review" as const,
  token: "t",
  owner: "o",
  repo: "r",
  prNumber: 1,
  body: "summary body",
  sentinel: REVIEW_SUMMARY_SENTINEL,
};

describe("upsertSummaryCommentWithCreationClaim", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProgressCommentOwner).mockResolvedValue(null);
    vi.mocked(getProgressCommentRevision).mockResolvedValue(null);
    vi.mocked(getProgressStubPostedAtMs).mockResolvedValue(null);
    vi.mocked(getSummaryCommentGithubId).mockResolvedValue(null);
    vi.mocked(claimSummaryCommentCreation).mockResolvedValue(true);
    vi.mocked(resolveVerifiedSummaryCommentRef).mockResolvedValue(null);
    vi.mocked(findIssueCommentBySentinel).mockResolvedValue(null);
    vi.mocked(upsertReviewSummaryComment).mockResolvedValue({ id: 99, updated: false });
  });

  it("creates when claim won and no stored id", async () => {
    await upsertSummaryCommentWithCreationClaim(claimBase);

    expect(claimSummaryCommentCreation).toHaveBeenCalledWith(pool, "wi-1", "o/r#1", "review");
    expect(findIssueCommentBySentinel).toHaveBeenCalled();
    expect(upsertReviewSummaryComment).toHaveBeenCalledWith(
      "t",
      "o",
      "r",
      1,
      "summary body",
      REVIEW_SUMMARY_SENTINEL,
      null,
      undefined,
    );
  });

  it("uses stored id without scanning when verified", async () => {
    vi.mocked(getSummaryCommentGithubId).mockResolvedValue(55);
    vi.mocked(resolveVerifiedSummaryCommentRef).mockResolvedValue({
      id: 55,
      url: "https://example.com/55",
      source: "hint",
    });

    await upsertSummaryCommentWithCreationClaim(claimBase);

    expect(claimSummaryCommentCreation).not.toHaveBeenCalled();
    expect(findIssueCommentBySentinel).not.toHaveBeenCalled();
    expect(upsertReviewSummaryComment).toHaveBeenCalledWith(
      "t",
      "o",
      "r",
      1,
      "summary body",
      REVIEW_SUMMARY_SENTINEL,
      { id: 55, url: "https://example.com/55" },
      undefined,
    );
  });

  it("updates polled id when claim lost", async () => {
    vi.useFakeTimers();
    vi.mocked(claimSummaryCommentCreation).mockResolvedValue(false);
    vi.mocked(getSummaryCommentGithubId).mockResolvedValueOnce(null).mockResolvedValueOnce(77);
    vi.mocked(resolveVerifiedSummaryCommentRef).mockResolvedValue({
      id: 77,
      url: "https://example.com/77",
      source: "hint",
    });

    const pending = upsertSummaryCommentWithCreationClaim(claimBase);
    await vi.advanceTimersByTimeAsync(1_500);
    await pending;

    expect(getSummaryCommentGithubId).toHaveBeenCalled();
    expect(findIssueCommentBySentinel).not.toHaveBeenCalled();
    expect(upsertReviewSummaryComment).toHaveBeenCalledWith(
      "t",
      "o",
      "r",
      1,
      "summary body",
      REVIEW_SUMMARY_SENTINEL,
      { id: 77, url: "https://example.com/77" },
      undefined,
    );
    vi.useRealTimers();
  });

  it("creates as last resort when claim lost and poll misses", async () => {
    vi.useFakeTimers();
    vi.mocked(claimSummaryCommentCreation).mockResolvedValue(false);
    vi.mocked(findIssueCommentBySentinel).mockResolvedValue(null);

    const pending = upsertSummaryCommentWithCreationClaim(claimBase);
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;

    expect(findIssueCommentBySentinel).toHaveBeenCalled();
    expect(upsertReviewSummaryComment).toHaveBeenCalledWith(
      "t",
      "o",
      "r",
      1,
      "summary body",
      REVIEW_SUMMARY_SENTINEL,
      null,
      undefined,
    );
    vi.useRealTimers();
  });

  it("does not let a delayed specialist tick overwrite the final summary", async () => {
    const { pool: lockedPool, query, release } = createLockedPool();
    vi.mocked(getProgressCommentRevision).mockResolvedValue({ workItemId: "wi-1", revision: 5 });
    vi.mocked(findIssueCommentBySentinel).mockResolvedValue({
      id: 88,
      url: "https://example.com/88",
      body: `${REVIEW_SUMMARY_SENTINEL}\n\nfinal\n<!-- pr-agent:progress-revision workItemId=wi-1 value=6 -->`,
    });

    await expect(
      upsertSummaryCommentWithCreationClaim({
        ...claimBase,
        pool: lockedPool,
        progressRevision: 1,
      }),
    ).resolves.toEqual({ id: 88, updated: false, skipped: true });

    expect(upsertReviewSummaryComment).not.toHaveBeenCalled();
    expect(recordPublishStep).not.toHaveBeenCalled();
    expect(query.mock.calls[0]?.[0]).toContain("pg_advisory_lock");
    expect(query.mock.calls.at(-1)?.[0]).toContain("pg_advisory_unlock");
    expect(release).toHaveBeenCalledOnce();
  });

  it("uses a stable NUL-free advisory lock key", async () => {
    const { pool: lockedPool, query } = createLockedPool();
    vi.mocked(getProgressCommentRevision).mockResolvedValue({ workItemId: "wi-1", revision: 5 });
    vi.mocked(findIssueCommentBySentinel).mockResolvedValue({
      id: 88,
      url: "https://example.com/88",
      body: `${REVIEW_SUMMARY_SENTINEL}\n<!-- pr-agent:progress-revision workItemId=wi-1 value=6 -->`,
    });

    await upsertSummaryCommentWithCreationClaim({
      ...claimBase,
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

    await upsertSummaryCommentWithCreationClaim({
      ...claimBase,
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
    vi.mocked(findIssueCommentBySentinel).mockResolvedValue({
      id: 99,
      url: "https://example.com/99",
      body: `${REVIEW_SUMMARY_SENTINEL}\n<!-- pr-agent:progress-revision workItemId=wi-1 value=0 -->`,
    });
    vi.setSystemTime(new Date("2026-07-22T12:05:00.000Z"));

    await upsertSummaryCommentWithCreationClaim({
      ...claimBase,
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

  it("preserves the prior CI row when a later progress tick omits CI", async () => {
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
    vi.mocked(findIssueCommentBySentinel).mockResolvedValue({
      id: 88,
      url: "https://example.com/88",
      body: priorBody,
    });

    await upsertSummaryCommentWithCreationClaim({
      ...claimBase,
      pool: lockedPool,
      body: nextBody,
      progressRevision: 1,
    });

    const writtenBody = vi.mocked(upsertReviewSummaryComment).mock.calls[0]?.[4] as string;
    expect(writtenBody).toContain("<strong>CI</strong>");
    expect(writtenBody).toContain("CI is still running");
    expect(writtenBody.indexOf("<strong>Source</strong>")).toBeLessThan(
      writtenBody.indexOf("<strong>CI</strong>"),
    );
    expect(writtenBody.indexOf("<strong>CI</strong>")).toBeLessThan(
      writtenBody.indexOf("<strong>Recon</strong>"),
    );
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
    vi.mocked(findIssueCommentBySentinel).mockResolvedValue({
      id: 88,
      url: "https://example.com/88",
      body: `${REVIEW_SUMMARY_SENTINEL}\n<!-- pr-agent:progress-revision workItemId=wi-old value=6 -->`,
    });
    vi.mocked(resolveVerifiedSummaryCommentRef).mockResolvedValue({
      id: 88,
      url: "https://example.com/88",
      source: "hint",
    });

    await expect(
      upsertSummaryCommentWithCreationClaim({
        ...claimBase,
        pool: lockedPool,
        progressRevision: 0,
      }),
    ).resolves.toMatchObject({ id: 99 });

    expect(upsertReviewSummaryComment).toHaveBeenCalledWith(
      "t",
      "o",
      "r",
      1,
      expect.stringContaining("workItemId=wi-1 value=0"),
      REVIEW_SUMMARY_SENTINEL,
      { id: 88, url: "https://example.com/88" },
      undefined,
    );
  });

  it("skips summary upsert when another work item owns the progress record", async () => {
    const { pool: lockedPool } = createLockedPool();
    vi.mocked(getProgressCommentOwner).mockResolvedValue({
      workItemId: "wi-b",
      generation: 2,
    });
    vi.mocked(findIssueCommentBySentinel).mockResolvedValue({
      id: 88,
      url: "https://example.com/88",
      body: `${REVIEW_SUMMARY_SENTINEL}\n<!-- pr-agent:progress-revision workItemId=wi-b value=1 -->`,
    });

    await expect(
      upsertSummaryCommentWithCreationClaim({
        ...claimBase,
        pool: lockedPool,
        workItemId: "wi-a",
        progressRevision: 0,
      }),
    ).resolves.toMatchObject({ id: 88, updated: false, skipped: true });

    expect(upsertReviewSummaryComment).not.toHaveBeenCalled();
  });

  it("recovers from a crash after the GitHub write using the body revision marker", async () => {
    const { pool: lockedPool, release } = createLockedPool();
    vi.mocked(getProgressCommentRevision).mockResolvedValue(null);
    vi.mocked(findIssueCommentBySentinel).mockResolvedValue(null);
    vi.mocked(recordPublishStep).mockRejectedValueOnce(new Error("record failed"));

    await expect(
      upsertSummaryCommentWithCreationClaim({
        ...claimBase,
        pool: lockedPool,
        progressRevision: 2,
      }),
    ).rejects.toThrow("record failed");

    const writtenBody = vi.mocked(upsertReviewSummaryComment).mock.calls[0]?.[4];
    expect(writtenBody).toContain("workItemId=wi-1 value=2");
    vi.mocked(findIssueCommentBySentinel).mockResolvedValue({
      id: 99,
      url: "https://example.com/99",
      body: writtenBody ?? "",
    });

    await expect(
      upsertSummaryCommentWithCreationClaim({
        ...claimBase,
        pool: lockedPool,
        progressRevision: 2,
      }),
    ).resolves.toEqual({ id: 99, updated: false, skipped: true });

    expect(upsertReviewSummaryComment).toHaveBeenCalledOnce();
    expect(recordPublishStep).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("records a revision after the GitHub upsert and unlocks on failure", async () => {
    const { client, pool: lockedPool, query, release } = createLockedPool();
    vi.mocked(getProgressCommentRevision).mockResolvedValue({ workItemId: "wi-1", revision: 0 });
    vi.mocked(findIssueCommentBySentinel).mockResolvedValue({
      id: 88,
      url: "https://example.com/88",
      body: `${REVIEW_SUMMARY_SENTINEL}\n<!-- pr-agent:progress-revision workItemId=wi-1 value=0 -->`,
    });
    vi.mocked(upsertReviewSummaryComment).mockRejectedValueOnce(new Error("write failed"));

    await expect(
      upsertSummaryCommentWithCreationClaim({
        ...claimBase,
        pool: lockedPool,
        progressRevision: 2,
      }),
    ).rejects.toThrow("write failed");

    expect(getProgressCommentRevision).toHaveBeenCalledWith(client, "o/r#1", "review");
    expect(recordPublishStep).not.toHaveBeenCalled();
    expect(query.mock.calls.at(-1)?.[0]).toContain("pg_advisory_unlock");
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases the client when advisory lock acquisition fails", async () => {
    const { pool: lockedPool, query, release } = createLockedPool();
    query.mockRejectedValueOnce(new Error("lock failed"));

    await expect(
      upsertSummaryCommentWithCreationClaim({
        ...claimBase,
        pool: lockedPool,
        progressRevision: 1,
      }),
    ).rejects.toThrow("lock failed");

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain("pg_advisory_lock");
    expect(release).toHaveBeenCalledOnce();
  });

  it("destroys the client and surfaces an unlock-only failure", async () => {
    const { pool: lockedPool, query, release } = createLockedPool();
    query.mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(new Error("unlock failed"));
    vi.mocked(getProgressCommentRevision).mockResolvedValue({ workItemId: "wi-1", revision: 5 });
    vi.mocked(findIssueCommentBySentinel).mockResolvedValue({
      id: 88,
      url: "https://example.com/88",
      body: `${REVIEW_SUMMARY_SENTINEL}\n<!-- pr-agent:progress-revision workItemId=wi-1 value=6 -->`,
    });

    await expect(
      upsertSummaryCommentWithCreationClaim({
        ...claimBase,
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
    query.mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(new Error("unlock failed"));
    vi.mocked(getProgressCommentRevision).mockRejectedValueOnce(new Error("operation failed"));

    await expect(
      upsertSummaryCommentWithCreationClaim({
        ...claimBase,
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
});

describe("publishReview summary coordination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProgressCommentRevision).mockResolvedValue(null);
    vi.mocked(getSummaryCommentGithubId).mockResolvedValue(88);
    vi.mocked(claimSummaryCommentCreation).mockResolvedValue(true);
    vi.mocked(resolveVerifiedSummaryCommentRef).mockResolvedValue({
      id: 88,
      url: "https://example.com/88",
      source: "hint",
    });
    vi.mocked(upsertReviewSummaryComment).mockResolvedValue({ id: 88, updated: true });
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

    expect(findIssueCommentBySentinel).toHaveBeenCalled();
    expect(upsertReviewSummaryComment).toHaveBeenCalledWith(
      "t",
      "o",
      "r",
      1,
      expect.stringContaining("<!-- pr-agent:progress-revision workItemId=wi-1 value=7 -->"),
      REVIEW_SUMMARY_SENTINEL,
      { id: 88, url: "https://example.com/88" },
      undefined,
    );
    expect(lockQuery.mock.calls.some(([sql]) => sql.includes("pg_advisory_lock"))).toBe(true);
    expect(lockQuery.mock.calls.some(([sql]) => sql.includes("pg_advisory_unlock"))).toBe(true);
  });
});
