import { describe, expect, it, vi, beforeEach } from "vitest";
import { REVIEW_SUMMARY_SENTINEL } from "../src/review/reviewSchema.js";

const listComments = vi.fn();
const updateComment = vi.fn();

vi.mock("../src/github/appAuth.js", () => ({
  installationOctokit: () => ({
    rest: {
      issues: {
        listComments,
        updateComment,
      },
    },
    paginate: async (
      method: (params: Record<string, unknown>) => Promise<{ data: unknown[] }>,
      params: Record<string, unknown>,
      map: (response: { data: unknown[] }, done: () => void) => unknown,
    ) => {
      const all: unknown[] = [];
      let page = 1;
      for (;;) {
        const response = await method({ ...params, page });
        map(response, () => undefined);
        all.push(...response.data);
        if (response.data.length < (params.per_page as number)) break;
        page += 1;
      }
      return all;
    },
  }),
}));

import {
  findIssueCommentBySentinel,
  upsertReviewSummaryComment,
} from "../src/github/reviewPublish.js";

describe("findIssueCommentBySentinel", () => {
  beforeEach(() => {
    listComments.mockReset();
    updateComment.mockReset();
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
