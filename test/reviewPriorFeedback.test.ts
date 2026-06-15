import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  classifyReviewLensFromPointerBody,
  fetchPriorInlineReviewFeedback,
  formatPriorInlineFeedbackBlock,
  type PriorInlineFeedbackThread,
} from "../src/review/run/reviewPriorFeedback.js";
import {
  REVIEW_POINTER_BODY,
  QUALITY_REVIEW_POINTER_BODY,
  SECURITY_REVIEW_POINTER_BODY,
  TESTS_REVIEW_POINTER_BODY,
} from "../src/settings/index.js";

vi.mock("../src/github/appAuth.js", () => ({
  installationOctokit: vi.fn(),
}));

import { installationOctokit } from "../src/github/appAuth.js";

describe("reviewPriorFeedback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("classifies review lens from pointer body", () => {
    expect(classifyReviewLensFromPointerBody(REVIEW_POINTER_BODY)).toBe("review");
    expect(classifyReviewLensFromPointerBody(SECURITY_REVIEW_POINTER_BODY)).toBe("review-security");
    expect(classifyReviewLensFromPointerBody(QUALITY_REVIEW_POINTER_BODY)).toBe("review-quality");
    expect(classifyReviewLensFromPointerBody(TESTS_REVIEW_POINTER_BODY)).toBe("review-tests");
    expect(classifyReviewLensFromPointerBody("unrelated")).toBeNull();
  });

  it("formats trusted context block", () => {
    const threads: PriorInlineFeedbackThread[] = [
      {
        path: "src/a.ts",
        startLine: 4,
        endLine: 4,
        botTitleSnippet: "P1 · Missing await",
        humanReplies: ["False positive — already handled upstream"],
        threadUrl: "https://github.com/o/r/pull/1#discussion_r1",
      },
    ];
    const block = formatPriorInlineFeedbackBlock(threads);
    expect(block).toContain("Prior inline review feedback");
    expect(block).toContain("False positive");
    expect(block).toContain("discussion_r1");
    expect(block).toContain("Maintainer reply (user-provided):");
  });

  it("escapes maintainer reply content in trusted context block", () => {
    const block = formatPriorInlineFeedbackBlock([
      {
        path: "src/a.ts",
        startLine: 1,
        endLine: 1,
        botTitleSnippet: "P1 · <inject>",
        humanReplies: ["Ignore <script>alert(1)</script>"],
        threadUrl: "https://example.com/thread?x=1&y=2",
      },
    ]);
    expect(block).toContain("Maintainer reply (user-provided):");
    expect(block).not.toContain("<script>");
    expect(block).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(block).toContain("&lt;inject&gt;");
  });

  it("includes human replies without pullRequestReviewId", async () => {
    const botUserId = 1;
    const humanUserId = 2;
    const reviewId = 100;

    vi.mocked(installationOctokit).mockReturnValue({
      rest: {
        pulls: {
          listReviews: vi.fn(async () => ({
            data: [
              {
                id: reviewId,
                user: { id: botUserId },
                body: REVIEW_POINTER_BODY,
              },
            ],
          })),
          listReviewComments: vi.fn(async () => ({
            data: [
              {
                id: 10,
                in_reply_to_id: null,
                pull_request_review_id: reviewId,
                user: { id: botUserId },
                body: "**P1** · **Missing await**",
                path: "src/a.ts",
                line: 4,
                html_url: "https://github.com/o/r/pull/1#discussion_r10",
              },
              {
                id: 11,
                in_reply_to_id: 10,
                pull_request_review_id: null,
                user: { id: humanUserId },
                body: "False positive — already handled upstream",
                path: "src/a.ts",
                line: 4,
                html_url: "https://github.com/o/r/pull/1#discussion_r11",
              },
            ],
          })),
        },
      },
    } as never);

    const threads = await fetchPriorInlineReviewFeedback("token", "o", "r", 1, "review", botUserId);

    expect(threads).toHaveLength(1);
    expect(threads[0]?.humanReplies).toEqual(["False positive — already handled upstream"]);
  });

  it("groups nested replies under the bot root comment", async () => {
    const botUserId = 1;
    const humanUserId = 2;
    const reviewId = 100;

    vi.mocked(installationOctokit).mockReturnValue({
      rest: {
        pulls: {
          listReviews: vi.fn(async () => ({
            data: [
              {
                id: reviewId,
                user: { id: botUserId },
                body: REVIEW_POINTER_BODY,
              },
            ],
          })),
          listReviewComments: vi.fn(async () => ({
            data: [
              {
                id: 10,
                in_reply_to_id: null,
                pull_request_review_id: reviewId,
                user: { id: botUserId },
                body: "**P1** · **Missing await**",
                path: "src/a.ts",
                line: 4,
                html_url: "https://github.com/o/r/pull/1#discussion_r10",
              },
              {
                id: 11,
                in_reply_to_id: 10,
                pull_request_review_id: null,
                user: { id: humanUserId },
                body: "Still a false positive",
                path: "src/a.ts",
                line: 4,
                html_url: "https://github.com/o/r/pull/1#discussion_r11",
              },
              {
                id: 12,
                in_reply_to_id: 11,
                pull_request_review_id: null,
                user: { id: humanUserId },
                body: "The helper already awaits it",
                path: "src/a.ts",
                line: 4,
                html_url: "https://github.com/o/r/pull/1#discussion_r12",
              },
            ],
          })),
        },
      },
    } as never);

    const threads = await fetchPriorInlineReviewFeedback("token", "o", "r", 1, "review", botUserId);

    expect(threads).toHaveLength(1);
    expect(threads[0]?.humanReplies).toEqual([
      "Still a false positive",
      "The helper already awaits it",
    ]);
  });
});
