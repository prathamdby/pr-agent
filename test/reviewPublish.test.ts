import { describe, expect, it, vi, beforeEach } from "vitest";
import { REVIEW_SUMMARY_SENTINEL } from "../src/review/reviewSchema.js";

const listComments = vi.fn();
const updateComment = vi.fn();
const createCheckRun = vi.fn();
const updateCheckRun = vi.fn();
const listCheckRunsForRef = vi.fn();

vi.mock("../src/github/appAuth.js", () => ({
  installationOctokit: () => ({
    rest: {
      issues: {
        listComments,
        updateComment,
      },
      checks: {
        create: createCheckRun,
        update: updateCheckRun,
        listForRef: listCheckRunsForRef,
      },
    },
  }),
}));

import {
  createReviewCheckRun,
  findIssueCommentBySentinel,
  findReviewCheckRunByName,
  updateReviewCheckRun,
  upsertReviewSummaryComment,
} from "../src/github/reviewPublish.js";

describe("findIssueCommentBySentinel", () => {
  beforeEach(() => {
    listComments.mockReset();
    updateComment.mockReset();
    createCheckRun.mockReset();
    updateCheckRun.mockReset();
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
