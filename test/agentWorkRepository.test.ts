import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Pool } from "pg";

vi.mock("../src/db/postgres.js", () => ({
  queryOne: vi.fn(),
}));

import { queryOne } from "../src/db/postgres.js";
import {
  listTriageEligibleInlineReviews,
  loadReviewExecutorPublishContext,
  claimQueuedWorkItem,
  claimSummaryCommentCreation,
  getWorkItem,
  recordReviewCheckRun,
  recordPublishStep,
  reserveReviewCheckRun,
} from "../src/agentWork/repository.js";
import { WorkItemPayloadValidationError } from "../src/agentWork/workItemPayloadSchema.js";

const pool = {} as Pool;

describe("loadReviewExecutorPublishContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps one batched publish_records query into executor context", async () => {
    vi.mocked(queryOne).mockResolvedValue({
      current_publish: [
        { step: "inline_review", github_id: "42" },
        { step: "summary_comment", github_id: "99" },
      ],
      prior_summary_exists: true,
      fingerprint_details: [{ detail: { fingerprints: ["fp-1", "fp-2"] } }],
      latest_summary_github_id: "1001",
    });

    await expect(
      loadReviewExecutorPublishContext(pool, "wi-1", "o/r#1", "review"),
    ).resolves.toEqual({
      publishState: {
        inlinePublished: true,
        summaryPublished: true,
        inlineReviewId: 42,
      },
      shouldLinkToSummary: true,
      storedInlineFingerprints: ["fp-1", "fp-2"],
      summaryCommentGithubId: 1001,
    });

    expect(queryOne).toHaveBeenCalledTimes(1);
    expect(vi.mocked(queryOne).mock.calls[0]?.[1]).toContain("json_agg");
    expect(vi.mocked(queryOne).mock.calls[0]?.[2]).toEqual(["o/r#1", "review", "wi-1"]);
  });

  it("omits summary comment hint when no prior summary publish exists", async () => {
    vi.mocked(queryOne).mockResolvedValue({
      current_publish: [],
      prior_summary_exists: false,
      fingerprint_details: [],
      latest_summary_github_id: "1001",
    });

    await expect(
      loadReviewExecutorPublishContext(pool, "wi-2", "o/r#1", "review-security"),
    ).resolves.toMatchObject({
      shouldLinkToSummary: false,
      summaryCommentGithubId: null,
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

describe("review check run publish records", () => {
  it("uses the shared-step conflict predicate that matches the partial index", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    const scopedPool = { query } as unknown as Pool;

    await recordPublishStep(scopedPool, {
      workItemId: "wi-1",
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

  it("rejects malformed payloads at getWorkItem", async () => {
    vi.mocked(queryOne).mockResolvedValue(reviewRow({ payload: { question: "wrong type shape" } }));

    await expect(getWorkItem(pool, "wi-1")).rejects.toBeInstanceOf(WorkItemPayloadValidationError);
  });

  it("marks claimed work failed when RETURNING payload is malformed", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    vi.mocked(queryOne).mockResolvedValueOnce(
      reviewRow({ status: "running", payload: { mode: "review" } }),
    );
    const scopedPool = { query } as unknown as Pool;

    await expect(claimQueuedWorkItem(scopedPool, "wi-1", "review")).rejects.toBeInstanceOf(
      WorkItemPayloadValidationError,
    );

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'failed'"),
      expect.arrayContaining(["wi-1"]),
    );
  });
});
