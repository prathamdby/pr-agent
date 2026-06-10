import { describe, expect, it, vi, beforeEach } from "vitest";
import { publishInlineReviewComments } from "../src/review/reviewInlinePublish.js";
import type { ReviewFinding } from "../src/review/reviewSchema.js";
import type { InlinePlacement } from "../src/review/reviewDiffPlacement.js";

vi.mock("../src/github/reviewPublish.js", () => ({
  createPullRequestReviewWithComments: vi.fn(),
}));

vi.mock("../src/github/reviewPublishRetry.js", () => ({
  withTransientReviewRetry: (fn: () => Promise<unknown>) => fn(),
}));

import { createPullRequestReviewWithComments } from "../src/github/reviewPublish.js";

function finding(severity: ReviewFinding["severity"], file: string, line: number): ReviewFinding {
  return {
    severity,
    file,
    startLine: line,
    endLine: line,
    title: `${severity} issue`,
    detail: "detail",
    fixPrompt: "fix",
  };
}

function placement(f: ReviewFinding): InlinePlacement {
  return { finding: f, inlineLine: f.startLine, inlinePosted: true };
}

describe("publishInlineReviewComments", () => {
  beforeEach(() => {
    vi.mocked(createPullRequestReviewWithComments).mockReset();
  });

  it("drops failing anchor and publishes the rest", async () => {
    vi.mocked(createPullRequestReviewWithComments)
      .mockRejectedValueOnce(new Error("Line could not be resolved"))
      .mockResolvedValueOnce({ id: 9, url: "https://example.com/review/9" });

    const p1 = placement(finding("P1", "src/a.ts", 1));
    const p2 = placement(finding("P2", "src/b.ts", 2));

    const result = await publishInlineReviewComments("token", "o", "r", 1, {
      renderReviewBody: () => "pointer",
      event: "COMMENT",
      commitId: "sha",
      inlinePlacements: [p1, p2],
      renderCommentBody: (f) => f.title,
    });

    expect(result.review?.id).toBe(9);
    expect(result.postedPlacements).toHaveLength(1);
    expect(result.postedPlacements[0]?.finding.file).toBe("src/a.ts");
    expect(result.anchorDroppedPlacements).toHaveLength(1);
    expect(result.anchorDroppedPlacements[0]?.finding.file).toBe("src/b.ts");
    expect(result.lineResolutionFallback).toBe(true);
    expect(createPullRequestReviewWithComments).toHaveBeenCalledTimes(2);
  });

  it("drops the hinted failing anchor when GitHub identifies it", async () => {
    vi.mocked(createPullRequestReviewWithComments)
      .mockRejectedValueOnce({
        message: "Line could not be resolved",
        response: {
          data: {
            errors: [{ path: "src/a.ts", line: 1 }],
          },
        },
      })
      .mockResolvedValueOnce({ id: 9, url: "https://example.com/review/9" });

    const p1 = placement(finding("P1", "src/a.ts", 1));
    const p2 = placement(finding("P2", "src/b.ts", 2));
    const p3 = placement(finding("P3", "src/c.ts", 3));

    const result = await publishInlineReviewComments("token", "o", "r", 1, {
      renderReviewBody: () => "pointer",
      event: "COMMENT",
      commitId: "sha",
      inlinePlacements: [p1, p2, p3],
      renderCommentBody: (f) => f.title,
    });

    expect(result.review?.id).toBe(9);
    expect(result.postedPlacements.map((p) => p.finding.file)).toEqual(["src/b.ts", "src/c.ts"]);
    expect(result.anchorDroppedPlacements.map((p) => p.finding.file)).toEqual(["src/a.ts"]);
    expect(createPullRequestReviewWithComments).toHaveBeenCalledTimes(2);
  });

  it("does not spend halving attempts on single-anchor hints", async () => {
    const placements = Array.from({ length: 20 }, (_, i) =>
      placement(finding(i < 13 ? "P1" : "P2", `src/${i}.ts`, i + 1)),
    );
    for (const placement of placements.slice(0, 13)) {
      vi.mocked(createPullRequestReviewWithComments).mockRejectedValueOnce({
        message: "Line could not be resolved",
        response: {
          data: {
            errors: [{ path: placement.finding.file, line: placement.inlineLine }],
          },
        },
      });
    }
    vi.mocked(createPullRequestReviewWithComments).mockResolvedValueOnce({
      id: 9,
      url: "https://example.com/review/9",
    });

    const result = await publishInlineReviewComments("token", "o", "r", 1, {
      renderReviewBody: () => "pointer",
      event: "COMMENT",
      commitId: "sha",
      inlinePlacements: placements,
      renderCommentBody: (f) => f.title,
    });

    expect(result.review?.id).toBe(9);
    expect(result.postedPlacements.map((p) => p.finding.file)).toEqual(
      placements.slice(13).map((p) => p.finding.file),
    );
    expect(result.anchorDroppedPlacements.map((p) => p.finding.file)).toEqual(
      placements.slice(0, 13).map((p) => p.finding.file),
    );
    expect(createPullRequestReviewWithComments).toHaveBeenCalledTimes(14);
  });

  it("drops one generic line failure and reuses rendered comment bodies", async () => {
    vi.mocked(createPullRequestReviewWithComments)
      .mockRejectedValueOnce(new Error("Line could not be resolved"))
      .mockResolvedValueOnce({ id: 9, url: "https://example.com/review/9" });

    const placements = Array.from({ length: 8 }, (_, i) =>
      placement(finding(i < 4 ? "P1" : "P2", `src/${i}.ts`, i + 1)),
    );
    const renderCommentBody = vi.fn((f: ReviewFinding) => f.title);

    const result = await publishInlineReviewComments("token", "o", "r", 1, {
      renderReviewBody: () => "pointer",
      event: "COMMENT",
      commitId: "sha",
      inlinePlacements: placements,
      renderCommentBody,
    });

    const secondAttempt = vi.mocked(createPullRequestReviewWithComments).mock.calls[1]?.[4];
    expect(result.review?.id).toBe(9);
    expect(result.postedPlacements).toHaveLength(7);
    expect(result.anchorDroppedPlacements).toHaveLength(1);
    expect(secondAttempt?.comments).toHaveLength(7);
    expect(renderCommentBody).toHaveBeenCalledTimes(8);
  });

  it("does not set lineResolutionFallback without anchor drops", async () => {
    const invalidAnchor = {
      finding: finding("P1", "src/a.ts", 1),
      inlineLine: null,
      inlinePosted: true,
    };

    const result = await publishInlineReviewComments("token", "o", "r", 1, {
      renderReviewBody: () => "pointer",
      event: "COMMENT",
      commitId: "sha",
      inlinePlacements: [invalidAnchor],
      renderCommentBody: (f) => f.title,
    });

    expect(result.lineResolutionFallback).toBe(false);
    expect(result.postedPlacements).toHaveLength(0);
    expect(createPullRequestReviewWithComments).not.toHaveBeenCalled();
  });
});
