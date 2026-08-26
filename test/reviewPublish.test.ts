import { describe, expect, it, vi, beforeEach } from "vitest";
import { REVIEW_SUMMARY_SENTINEL } from "../src/review/reviewSchema.js";
import {
  CHECK_RUNS_MAX_PAGES,
  CHECK_RUNS_PAGE_SIZE,
  COMMENTS_PAGE_SIZE,
} from "../src/settings/index.js";
import { syncReviewLabels } from "../src/review/run/reviewLabels.js";

const {
  listComments,
  updateComment,
  createCheckRun,
  updateCheckRun,
  listCheckRunsForRef,
  listLabelsOnIssue,
  createReview,
  listReviews,
  installationOctokit,
} = vi.hoisted(() => {
  const listCommentsFn = vi.fn();
  const updateCommentFn = vi.fn();
  const createCheckRunFn = vi.fn();
  const updateCheckRunFn = vi.fn();
  const listCheckRunsForRefFn = vi.fn();
  const listLabelsOnIssueFn = vi.fn();
  const createReviewFn = vi.fn();
  const listReviewsFn = vi.fn();
  const installationOctokitFn = vi.fn(() => ({
    rest: {
      issues: {
        listComments: listCommentsFn,
        updateComment: updateCommentFn,
        listLabelsOnIssue: listLabelsOnIssueFn,
      },
      checks: {
        create: createCheckRunFn,
        update: updateCheckRunFn,
        listForRef: listCheckRunsForRefFn,
      },
      pulls: {
        createReview: createReviewFn,
        listReviews: listReviewsFn,
      },
    },
  }));
  return {
    listComments: listCommentsFn,
    updateComment: updateCommentFn,
    createCheckRun: createCheckRunFn,
    updateCheckRun: updateCheckRunFn,
    listCheckRunsForRef: listCheckRunsForRefFn,
    listLabelsOnIssue: listLabelsOnIssueFn,
    createReview: createReviewFn,
    listReviews: listReviewsFn,
    installationOctokit: installationOctokitFn,
  };
});

vi.mock("../src/github/appAuth.js", () => ({
  installationOctokit,
}));

import {
  createPullRequestReviewWithComments,
  createReviewCheckRun,
  findIssueCommentBySentinel,
  findPullRequestReviewByMarker,
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
    listReviews.mockReset();
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
    expect(hit).toEqual({
      id: 102,
      url: undefined,
      body: `${REVIEW_SUMMARY_SENTINEL}\n\nnewest`,
    });
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
      name: i === 0 ? "size:XS" : `custom-${i}`,
    }));
    const pageTwo = [{ name: "must-preserve" }, { name: "also-preserve" }];
    listLabelsOnIssue.mockResolvedValueOnce({ data: pageOne }).mockResolvedValueOnce({
      data: pageTwo,
    });

    const current = await listPullRequestLabels("tok", "o", "r", 7);
    const next = syncReviewLabels(current, ["size:S"]);

    expect(current).toHaveLength(COMMENTS_PAGE_SIZE + 2);
    expect(next).toContain("must-preserve");
    expect(next).toContain("also-preserve");
    expect(next).toContain("custom-1");
    expect(next).toContain("size:S");
    expect(next).not.toContain("size:XS");
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

describe("findPullRequestReviewByMarker", () => {
  beforeEach(() => {
    listReviews.mockReset();
    installationOctokit.mockClear();
  });

  it("requires the configured app author when recovering a marked review", async () => {
    const marker = "<!-- pr-agent:operation-intent review-marker -->";
    listReviews.mockResolvedValueOnce({
      data: [
        {
          id: 11,
          html_url: "https://github.com/o/r/pull/1#pullrequestreview-11",
          body: marker,
          commit_id: "sha-1",
          user: { login: "human-reviewer" },
        },
        {
          id: 12,
          html_url: "https://github.com/o/r/pull/1#pullrequestreview-12",
          body: marker,
          commit_id: "sha-1",
          user: { login: "pr-agent[bot]" },
        },
      ],
    });

    await expect(
      findPullRequestReviewByMarker("tok", "o", "r", 1, marker, "pr-agent[bot]", "sha-1"),
    ).resolves.toEqual({
      id: 12,
      url: "https://github.com/o/r/pull/1#pullrequestreview-12",
    });
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

  it("finds an existing check run by exact name, head sha, and external id", async () => {
    listCheckRunsForRef.mockResolvedValueOnce({
      data: {
        check_runs: [
          {
            id: 77,
            name: "PR Agent Review",
            head_sha: "abc123",
            external_id: "other-work-item",
            html_url: null,
          },
          {
            id: 88,
            name: "PR Agent Review",
            head_sha: "abc123",
            external_id: "wi-1",
            html_url: "https://github.com/o/r/runs/88",
          },
        ],
      },
    });

    await expect(
      findReviewCheckRunByName("tok", "o", "r", "abc123", "PR Agent Review", "wi-1"),
    ).resolves.toEqual({ id: 88, url: "https://github.com/o/r/runs/88" });

    expect(listCheckRunsForRef).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      ref: "abc123",
      filter: "all",
      check_name: "PR Agent Review",
      per_page: CHECK_RUNS_PAGE_SIZE,
      page: 1,
    });
  });

  it("paginates and ignores same-head runs owned by another work item", async () => {
    const firstPage = Array.from({ length: CHECK_RUNS_PAGE_SIZE }, (_, index) => ({
      id: index + 1,
      name: "PR Agent Review",
      head_sha: "abc123",
      external_id: `other-${index}`,
      html_url: null,
    }));
    listCheckRunsForRef.mockResolvedValueOnce({ data: { check_runs: firstPage } });
    listCheckRunsForRef.mockResolvedValueOnce({
      data: {
        check_runs: [
          {
            id: 202,
            name: "PR Agent Review",
            head_sha: "abc123",
            external_id: "wi-1",
            html_url: "https://github.com/o/r/runs/202",
          },
          {
            id: 203,
            name: "PR Agent Review",
            head_sha: "abc123",
            external_id: "other-work-item",
            html_url: null,
          },
        ],
      },
    });

    await expect(
      findReviewCheckRunByName("tok", "o", "r", "abc123", "PR Agent Review", "wi-1"),
    ).resolves.toEqual({ id: 202, url: "https://github.com/o/r/runs/202" });

    expect(listCheckRunsForRef).toHaveBeenNthCalledWith(2, {
      owner: "o",
      repo: "r",
      ref: "abc123",
      filter: "all",
      check_name: "PR Agent Review",
      per_page: CHECK_RUNS_PAGE_SIZE,
      page: 2,
    });
  });

  it("leaves recovery unresolved when the provider returns multiple exact matches", async () => {
    listCheckRunsForRef.mockResolvedValueOnce({
      data: {
        check_runs: [
          {
            id: 301,
            name: "PR Agent Review",
            head_sha: "abc123",
            external_id: "wi-1",
            html_url: null,
          },
          {
            id: 302,
            name: "PR Agent Review",
            head_sha: "abc123",
            external_id: "wi-1",
            html_url: null,
          },
        ],
      },
    });

    await expect(
      findReviewCheckRunByName("tok", "o", "r", "abc123", "PR Agent Review", "wi-1"),
    ).resolves.toBeNull();
  });

  it("leaves recovery unresolved when the provider omits external id", async () => {
    listCheckRunsForRef.mockResolvedValueOnce({
      data: {
        check_runs: [
          {
            id: 401,
            name: "PR Agent Review",
            head_sha: "abc123",
            html_url: "https://github.com/o/r/runs/401",
          },
        ],
      },
    });

    await expect(
      findReviewCheckRunByName("tok", "o", "r", "abc123", "PR Agent Review", "wi-1"),
    ).resolves.toBeNull();
  });

  it("leaves recovery unresolved when pagination reaches its cap", async () => {
    for (let page = 1; page <= CHECK_RUNS_MAX_PAGES; page++) {
      listCheckRunsForRef.mockResolvedValueOnce({
        data: {
          check_runs: Array.from({ length: CHECK_RUNS_PAGE_SIZE }, (_, index) => ({
            id: page * CHECK_RUNS_PAGE_SIZE + index,
            name: "PR Agent Review",
            head_sha: "abc123",
            external_id: page === 2 && index === 0 ? "wi-1" : `other-${page}-${index}`,
            html_url: null,
          })),
        },
      });
    }

    await expect(
      findReviewCheckRunByName("tok", "o", "r", "abc123", "PR Agent Review", "wi-1"),
    ).resolves.toBeNull();
    expect(listCheckRunsForRef).toHaveBeenCalledTimes(CHECK_RUNS_MAX_PAGES);
  });
});
