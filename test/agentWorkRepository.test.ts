import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Pool } from "pg";

vi.mock("../src/db/postgres.js", () => ({
  queryOne: vi.fn(),
}));

import { queryOne } from "../src/db/postgres.js";
import {
  listTriageEligibleInlineReviews,
  loadReviewExecutorPublishContext,
  claimSummaryCommentCreation,
  getProgressCommentOwner,
  getProgressCommentRevision,
  getProgressStubPostedAtMs,
  getWorkItem,
  recordReviewCheckRun,
  recordPublishStep,
  reserveReviewCheckRun,
  hasActiveReviewWorkItem,
} from "../src/agentWork/repository.js";
import { WorkItemPayloadValidationError } from "../src/agentWork/workItemPayloadSchema.js";

const pool = {} as Pool;

describe("loadReviewExecutorPublishContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("restores current batch review ids and merges stored fingerprints", async () => {
    const postedFinding = {
      severity: "P1",
      file: "src/a.ts",
      startLine: 10,
      endLine: 10,
      title: "Missing null check",
      detail: "The payload can be null.",
      fixPrompt: "Guard the payload before dereferencing it.",
    };
    vi.mocked(queryOne).mockResolvedValue({
      current_publish: [
        {
          step: "inline_review",
          github_id: "43",
          detail: {
            batches: [
              { batchId: "old", workItemId: "wi-0", reviewId: 41, fingerprints: ["fp-old"] },
              {
                batchId: "one",
                workItemId: "wi-1",
                specialist: "correctness",
                reviewId: 42,
                fingerprints: ["fp-1"],
                placements: [
                  {
                    finding: postedFinding,
                    resolvedLine: 10,
                    canonicalFingerprint: "fp-1",
                  },
                ],
              },
              { batchId: "two", workItemId: "wi-1", reviewId: 43, fingerprints: ["fp-2"] },
            ],
          },
        },
        { step: "summary_comment", github_id: "99" },
      ],
      prior_summary_exists: true,
      fingerprint_details: [
        {
          detail: {
            fingerprints: ["fp-legacy"],
            batches: [
              { batchId: "old", workItemId: "wi-0", reviewId: 41, fingerprints: ["fp-old"] },
              { batchId: "one", workItemId: "wi-1", reviewId: 42, fingerprints: ["fp-1"] },
              { batchId: "two", workItemId: "wi-1", reviewId: 43, fingerprints: ["fp-2"] },
            ],
          },
        },
      ],
      latest_progress_comment_github_id: "1001",
    });

    await expect(
      loadReviewExecutorPublishContext(pool, "wi-1", "o/r#1", "review"),
    ).resolves.toEqual({
      publishState: {
        summaryPublished: true,
        inlineReviewIds: [42, 43],
        threadCallCount: 2,
      },
      shouldLinkToSummary: true,
      storedInlineFingerprints: ["fp-legacy", "fp-old", "fp-1", "fp-2"],
      resumedPlacements: [
        {
          kind: "resumed",
          source: "correctness",
          placement: { finding: postedFinding, inlineLine: 10, inlinePosted: true },
          canonicalFingerprint: "fp-1",
          reviewId: 42,
        },
      ],
      progressCommentGithubId: 1001,
    });

    expect(queryOne).toHaveBeenCalledTimes(1);
    expect(vi.mocked(queryOne).mock.calls[0]?.[1]).toContain("json_agg");
    expect(vi.mocked(queryOne).mock.calls[0]?.[2]).toEqual(["o/r#1", "review", "wi-1"]);
  });

  it("returns the progress stub github id even when no prior summary publish exists", async () => {
    vi.mocked(queryOne).mockResolvedValue({
      current_publish: [],
      prior_summary_exists: false,
      fingerprint_details: [],
      latest_progress_comment_github_id: "1001",
    });

    await expect(
      loadReviewExecutorPublishContext(pool, "wi-2", "o/r#1", "review-security"),
    ).resolves.toMatchObject({
      shouldLinkToSummary: false,
      progressCommentGithubId: 1001,
    });
  });
});

describe("listTriageEligibleInlineReviews", () => {
  it("maps completed inline_review publish rows to review id and lens", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        { github_id: "10", review_lens: "review" },
        { github_id: "11", review_lens: "review-tests" },
        { github_id: "", review_lens: "review-quality" },
        { github_id: "0", review_lens: "review-security" },
      ],
    });
    const scopedPool = { query } as unknown as Pool;

    await expect(listTriageEligibleInlineReviews(scopedPool, "o/r#1")).resolves.toEqual(
      new Map([
        [10, "review"],
        [11, "review-tests"],
      ]),
    );

    expect(query).toHaveBeenCalledWith(expect.stringContaining("inline_review"), ["o/r#1"]);
  });
});

describe("publish records", () => {
  it("loads the scoped progress revision from the progress publish record", async () => {
    vi.mocked(queryOne).mockResolvedValue({ work_item_id: "wi-1", revision: 3 });

    await expect(getProgressCommentRevision(pool, "o/r#1", "review")).resolves.toEqual({
      workItemId: "wi-1",
      revision: 3,
    });

    expect(queryOne).toHaveBeenLastCalledWith(
      pool,
      expect.stringContaining("step = 'progress_comment'"),
      ["o/r#1", "review"],
    );
    expect(vi.mocked(queryOne).mock.calls.at(-1)?.[1]).toContain("progressRevision");
  });

  it("loads the current progress comment owner and generation", async () => {
    vi.mocked(queryOne).mockResolvedValue({ work_item_id: "wi-2", generation: 3 });

    await expect(getProgressCommentOwner(pool, "o/r#1", "review")).resolves.toEqual({
      workItemId: "wi-2",
      generation: 3,
    });

    expect(queryOne).toHaveBeenLastCalledWith(pool, expect.stringContaining("progressGeneration"), [
      "o/r#1",
      "review",
    ]);
  });

  it("returns null when no progress revision has been recorded", async () => {
    vi.mocked(queryOne).mockResolvedValue(null);

    await expect(getProgressCommentRevision(pool, "o/r#1", "review")).resolves.toBeNull();
  });

  it("loads stubPostedAtMs from the progress publish record", async () => {
    vi.mocked(queryOne).mockResolvedValue({ stub_posted_at_ms: "1710000000000" });

    await expect(getProgressStubPostedAtMs(pool, "o/r#1", "review")).resolves.toBe(
      1_710_000_000_000,
    );

    expect(queryOne).toHaveBeenLastCalledWith(pool, expect.stringContaining("stubPostedAtMs"), [
      "o/r#1",
      "review",
    ]);
  });

  it("returns null when stubPostedAtMs is absent", async () => {
    vi.mocked(queryOne).mockResolvedValue(null);

    await expect(getProgressStubPostedAtMs(pool, "o/r#1", "review")).resolves.toBeNull();
  });

  it("atomically appends unique inline batches in one publish record row", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    const scopedPool = { query } as unknown as Pool;
    const batch = {
      batchId: "batch-1",
      workItemId: "wi-1",
      reviewId: 42,
      fingerprints: ["fp-1"],
    };

    await recordPublishStep(scopedPool, {
      workItemId: "wi-1",
      leaseEpoch: null,
      resourceKey: "o/r#1",
      reviewLens: "review",
      step: "inline_review",
      githubId: 42,
      detail: batch,
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("jsonb_set"),
      expect.arrayContaining([JSON.stringify({ batches: [batch] })]),
    );
    expect(vi.mocked(query).mock.calls[0]?.[0]).toContain("batchId");
  });

  it("uses the shared-step conflict predicate that matches the partial index", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    const scopedPool = { query } as unknown as Pool;

    await recordPublishStep(scopedPool, {
      workItemId: "wi-1",
      leaseEpoch: null,
      resourceKey: "o/r#1",
      reviewLens: "review",
      step: "progress_comment",
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        "ON CONFLICT (resource_key, review_lens, step) WHERE review_lens <> 'ask' AND step <> 'check_run'",
      ),
      expect.arrayContaining(["wi-1", "o/r#1", "review", "progress_comment"]),
    );
  });

  it("uses the shared-step conflict predicate for summary creation claims", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    const scopedPool = { query } as unknown as Pool;

    await claimSummaryCommentCreation(scopedPool, "wi-1", "o/r#1", "review");

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        "ON CONFLICT (resource_key, review_lens, step) WHERE review_lens <> 'ask' AND step <> 'check_run'",
      ),
      expect.arrayContaining(["wi-1", "o/r#1", "review"]),
    );
  });

  it("reserves check runs with the work-item scoped conflict target", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    const scopedPool = { query } as unknown as Pool;

    await expect(
      reserveReviewCheckRun(scopedPool, {
        workItemId: "wi-1",
        resourceKey: "o/r#1",
        reviewLens: "review",
      }),
    ).resolves.toBe(true);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT (work_item_id, review_lens, step)"),
      expect.arrayContaining(["wi-1", "o/r#1", "review"]),
    );
  });

  it("records check run ids with the work-item scoped conflict target", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    const scopedPool = { query } as unknown as Pool;

    await recordReviewCheckRun(scopedPool, {
      workItemId: "wi-1",
      resourceKey: "o/r#1",
      reviewLens: "review",
      githubId: 123,
      detail: { status: "in_progress" },
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT (work_item_id, review_lens, step)"),
      expect.arrayContaining(["wi-1", "o/r#1", "review", "123"]),
    );
  });
});

describe("active review work", () => {
  it("checks queued and running review work for one PR resource", async () => {
    vi.mocked(queryOne).mockResolvedValue({ active: true });

    await expect(hasActiveReviewWorkItem(pool, "o/r#1")).resolves.toBe(true);

    expect(queryOne).toHaveBeenCalledWith(
      pool,
      expect.stringContaining("status IN ('queued', 'running')"),
      ["o/r#1"],
    );
    expect(vi.mocked(queryOne).mock.calls.at(-1)?.[1]).toContain("type = 'review'");
  });
});

function reviewRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "wi-1",
    webhook_event_id: "ev-1",
    type: "review",
    source: "auto",
    status: "running",
    owner: "o",
    repo: "r",
    pr_number: 1,
    installation_id: "42",
    head_sha: "deadbeef",
    review_lens: "review",
    resource_key: "o/r#1",
    attempt_count: 1,
    payload: { mode: "review", source: "auto", legacyFlag: true },
    cancel_requested_at: null,
    ...overrides,
  };
}

describe("mapWorkItem payload boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses payload and preserves unknown keys via getWorkItem", async () => {
    vi.mocked(queryOne).mockResolvedValue(reviewRow());

    const item = await getWorkItem(pool, "wi-1");
    expect(item).toMatchObject({
      type: "review",
      reviewLens: "review",
      payload: { mode: "review", source: "auto", legacyFlag: true },
    });
  });

  it.each(["review-security", "review-quality", "review-tests"] as const)(
    "normalizes stored %s database rows to the live review mode",
    async (reviewLens) => {
      vi.mocked(queryOne).mockResolvedValue(reviewRow({ review_lens: reviewLens }));

      await expect(getWorkItem(pool, "wi-1")).resolves.toMatchObject({
        type: "review",
        reviewLens: "review",
      });
    },
  );

  it("rejects malformed payloads at getWorkItem", async () => {
    vi.mocked(queryOne).mockResolvedValue(reviewRow({ payload: { question: "wrong type shape" } }));

    await expect(getWorkItem(pool, "wi-1")).rejects.toBeInstanceOf(WorkItemPayloadValidationError);
  });
});
