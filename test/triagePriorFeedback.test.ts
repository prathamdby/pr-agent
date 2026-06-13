import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  QUALITY_REVIEW_POINTER_BODY,
  REVIEW_POINTER_BODY,
  TESTS_REVIEW_POINTER_BODY,
} from "../src/settings/index.js";

const mocks = vi.hoisted(() => ({
  listReviews: vi.fn(),
  listReviewComments: vi.fn(),
}));

vi.mock("../src/github/appAuth.js", () => ({
  installationOctokit: vi.fn(() => ({
    rest: {
      pulls: {
        listReviews: mocks.listReviews,
        listReviewComments: mocks.listReviewComments,
      },
    },
  })),
}));

import { fetchBotFindingThreads } from "../src/review/reviewPriorFeedback.js";

describe("fetchBotFindingThreads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("collects bot-rooted review, security, quality findings and excludes review-tests", async () => {
    mocks.listReviews.mockResolvedValue({
      data: [
        { id: 10, user: { id: 99 }, body: REVIEW_POINTER_BODY },
        { id: 11, user: { id: 99 }, body: QUALITY_REVIEW_POINTER_BODY },
        { id: 12, user: { id: 99 }, body: TESTS_REVIEW_POINTER_BODY },
      ],
    });
    mocks.listReviewComments.mockResolvedValue({
      data: [
        {
          id: 1,
          in_reply_to_id: null,
          pull_request_review_id: 10,
          user: { id: 99 },
          body: "**P1** · **Null user**\nbody",
          path: "src/app.ts",
          line: 5,
          original_line: 5,
          html_url: "https://github.test/1",
        },
        {
          id: 2,
          in_reply_to_id: 1,
          pull_request_review_id: 10,
          user: { id: 7 },
          body: "please fix",
          path: "src/app.ts",
          line: 5,
          original_line: 5,
          html_url: "https://github.test/2",
        },
        {
          id: 3,
          in_reply_to_id: null,
          pull_request_review_id: 12,
          user: { id: 99 },
          body: "**P2** · **Add test**",
          path: "test/app.test.ts",
          line: 1,
          original_line: 1,
          html_url: "https://github.test/3",
        },
      ],
    });

    await expect(fetchBotFindingThreads("tok", "o", "r", 1, 99)).resolves.toEqual([
      expect.objectContaining({
        rootCommentId: 1,
        lens: "review",
        path: "src/app.ts",
        severity: "P1",
        humanReplies: ["please fix"],
      }),
    ]);
  });
});
