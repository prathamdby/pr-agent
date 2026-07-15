import { describe, expect, it, vi, beforeEach } from "vitest";
import { REVIEW_SUMMARY_SENTINEL } from "../src/review/reviewSchema.js";
import { COMMENTS_PAGE_SIZE } from "../src/settings/index.js";
import { syncReviewLabels } from "../src/review/run/reviewLabels.js";

const {
  listComments,
  updateComment,
  createCheckRun,
  updateCheckRun,
  listCheckRunsForRef,
  listLabelsOnIssue,
  createReview,
  installationOctokit,
} = vi.hoisted(() => {
  const listComments = vi.fn();
  const updateComment = vi.fn();
  const createCheckRun = vi.fn();
  const updateCheckRun = vi.fn();
  const listCheckRunsForRef = vi.fn();
  const listLabelsOnIssue = vi.fn();
  const createReview = vi.fn();
  const installationOctokit = vi.fn(() => ({
    rest: {
      issues: {
        listComments,
        updateComment,
        listLabelsOnIssue,
      },
      checks: {
        create: createCheckRun,
        update: updateCheckRun,
        listForRef: listCheckRunsForRef,
      },
      pulls: {
        createReview,
      },
    },
  }));
  return {
    listComments,
    updateComment,
    createCheckRun,
    updateCheckRun,
    listCheckRunsForRef,
    listLabelsOnIssue,
    createReview,
    installationOctokit,
  };
});

vi.mock("../src/github/appAuth.js", () => ({
  installationOctokit,
}));

import {
  createPullRequestReviewWithComments,
  createReviewCheckRun,
  findIssueCommentBySentinel,
  findReviewCheckRunByName,
  listPullRequestLabels,
  updateReviewCheckRun,
  upsertReviewSummaryComment,
} from "../src/github/reviewPublish.js";

describe("findIssueCommentBySentinel", () => {
  beforeEach(() => {
    listComments.mockReset();
    updateComment.mockReset();
    createCheckRun.mockReset();
    updateCheckRun.mockReset();
    listLabelsOnIssue.mockReset();
    createReview.mockReset();
    installationOctokit.mockClear();
  });

  it("paginates and returns the last matching comment across pages", async () => {
    const filler = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      body: `comment ${i}`,
    }));
    listComments.mockResolvedValueOnce({ data: filler }).mockResolvedValueOnce({
      data: [
        { id: 101, body: `${REVIEW_SUMMARY_SENTINEL}\n\nold` },
        { id: 102, body: `${REVIEW_SUMMARY_SENTINEL}\n\nnewest` },
      ],
    });

    const hit = await findIssueCommentBySentinel("tok", "o", "r", 42, REVIEW_SUMMARY_SENTINEL);

    expect(listComments).toHaveBeenCalledTimes(2);
    expect(hit).toEqual({ id: 102 });
  });

  it("returns null when no comment matches", async () => {
    listComments.mockResolvedValueOnce({ data: [{ id: 1, body: "hello" }] });

    const hit = await findIssueCommentBySentinel("tok", "o", "r", 1, REVIEW_SUMMARY_SENTINEL);

    expect(hit).toBeNull();
  });

  it("uses a scan-derived existing summary ref without paginating again", async () => {
    listComments.mockResolvedValueOnce({
      data: [{ id: 102, body: `${REVIEW_SUMMARY_SENTINEL}\n\nnewest` }],
    });

    const found = await findIssueCommentBySentinel("tok", "o", "r", 1, REVIEW_SUMMARY_SENTINEL);
    const result = await upsertReviewSummaryComment(
      "tok",
      "o",
      "r",
      1,
      `${REVIEW_SUMMARY_SENTINEL}\n\nupdated`,
      REVIEW_SUMMARY_SENTINEL,
      found,
    );

    expect(result).toEqual({ id: 102, updated: true });
    expect(listComments).toHaveBeenCalledTimes(1);
    expect(updateComment).toHaveBeenCalledWith(
      expect.objectContaining({
        comment_id: 102,
        body: `${REVIEW_SUMMARY_SENTINEL}\n\nupdated`,
      }),
    );
  });
});

describe("listPullRequestLabels", () => {
  beforeEach(() => {
    listLabelsOnIssue.mockReset();
    installationOctokit.mockClear();
  });

  it("paginates and returns labels beyond the first page", async () => {
    const pageOne = Array.from({ length: COMMENTS_PAGE_SIZE }, (_, i) => ({
      name: `label-${i + 1}`,
    }));
    const pageTwo = [{ name: "label-beyond-page-one" }, { name: "team-owned" }];
    listLabelsOnIssue.mockResolvedValueOnce({ data: pageOne }).mockResolvedValueOnce({
      data: pageTwo,
    });

    const labels = await listPullRequestLabels("tok", "o", "r", 42, 1_700_000_000_000);

    expect(installationOctokit).toHaveBeenCalledWith("tok", 1_700_000_000_000);
    expect(listLabelsOnIssue).toHaveBeenCalledTimes(2);
    expect(listLabelsOnIssue).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        owner: "o",
        repo: "r",
        issue_number: 42,
        per_page: COMMENTS_PAGE_SIZE,
        page: 1,
      }),
    );
    expect(listLabelsOnIssue).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        per_page: COMMENTS_PAGE_SIZE,
        page: 2,
      }),
    );
    expect(labels).toHaveLength(COMMENTS_PAGE_SIZE + 2);
    expect(labels).toContain("label-beyond-page-one");
    expect(labels).toContain("team-owned");
  });

  it("keeps later-page labels when computing replace-all setLabels payload", async () => {
    const pageOne = Array.from({ length: COMMENTS_PAGE_SIZE }, (_, i) => ({
      name: i === 0 ? "Review effort 1/5" : `custom-${i}`,
    }));
    const pageTwo = [{ name: "must-preserve" }, { name: "also-preserve" }];
    listLabelsOnIssue.mockResolvedValueOnce({ data: pageOne }).mockResolvedValueOnce({
      data: pageTwo,
    });

    const current = await listPullRequestLabels("tok", "o", "r", 7);
    const next = syncReviewLabels(current, ["Review effort 2/5"], "review");

    expect(current).toHaveLength(COMMENTS_PAGE_SIZE + 2);
    expect(next).toContain("must-preserve");
    expect(next).toContain("also-preserve");
    expect(next).toContain("custom-1");
    expect(next).toContain("Review effort 2/5");
    expect(next).not.toContain("Review effort 1/5");
  });
});

describe("createPullRequestReviewWithComments", () => {
  beforeEach(() => {
    createReview.mockReset();
    installationOctokit.mockClear();
  });

  it("forwards expiresAtTs to installationOctokit", async () => {
    createReview.mockResolvedValueOnce({
      data: { id: 9, html_url: "https://example.com/review/9" },
    });
    const expiresAtTs = 1_700_000_000_000;

    await createPullRequestReviewWithComments(
      "tok",
      "o",
      "r",
      1,
      {
        body: "pointer",
        event: "COMMENT",
        commitId: "sha",
      },
      expiresAtTs,
    );

    expect(installationOctokit).toHaveBeenCalledWith("tok", expiresAtTs);
    expect(createReview).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "o",
        repo: "r",
        pull_number: 1,
        body: "pointer",
        event: "COMMENT",
        commit_id: "sha",
      }),
    );
  });
});

describe("review check runs", () => {
  beforeEach(() => {
    createCheckRun.mockReset();
    updateCheckRun.mockReset();
    listCheckRunsForRef.mockReset();
  });

  it("creates an in-progress check run", async () => {
    createCheckRun.mockResolvedValueOnce({
      data: { id: 123, html_url: "https://github.com/o/r/runs/123" },
    });

    await expect(
      createReviewCheckRun("tok", "o", "r", {
        name: "PR Agent Review",
        headSha: "abc123",
        externalId: "wi-1",
        summary: "Running.",
      }),
    ).resolves.toEqual({ id: 123, url: "https://github.com/o/r/runs/123" });

    expect(createCheckRun).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      name: "PR Agent Review",
      head_sha: "abc123",
      status: "in_progress",
      started_at: expect.any(String),
      external_id: "wi-1",
      output: {
        title: "PR Agent Review",
        summary: "Running.",
      },
    });
  });

  it("updates a check run to completed", async () => {
    updateCheckRun.mockResolvedValueOnce({ data: {} });

    await updateReviewCheckRun("tok", "o", "r", 123, {
      name: "PR Agent Review",
      conclusion: "failure",
      completedAt: "2026-07-02T00:00:00.000Z",
      summary: "1 P0/P1 finding",
      detailsUrl: "https://github.com/o/r/pull/1#issuecomment-2",
    });

    expect(updateCheckRun).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      check_run_id: 123,
      name: "PR Agent Review",
      status: "completed",
      conclusion: "failure",
      completed_at: "2026-07-02T00:00:00.000Z",
      details_url: "https://github.com/o/r/pull/1#issuecomment-2",
      output: {
        title: "PR Agent Review",
        summary: "1 P0/P1 finding",
      },
    });
  });

  it("finds an existing check run by name on the head sha", async () => {
    listCheckRunsForRef.mockResolvedValueOnce({
      data: {
        check_runs: [
          { id: 77, name: "Other", head_sha: "abc123", html_url: null },
          {
            id: 88,
            name: "PR Agent Review",
            head_sha: "abc123",
            html_url: "https://github.com/o/r/runs/88",
          },
        ],
      },
    });

    await expect(
      findReviewCheckRunByName("tok", "o", "r", "abc123", "PR Agent Review"),
    ).resolves.toEqual({ id: 88, url: "https://github.com/o/r/runs/88" });

    expect(listCheckRunsForRef).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      ref: "abc123",
      filter: "latest",
      check_name: "PR Agent Review",
    });
  });
});
