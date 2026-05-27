import { describe, expect, it, vi, beforeEach } from "vitest";
import { publishInlineReviewComments } from "../src/agent/reviewInlinePublish.js";
import type { ReviewFinding } from "../src/agent/reviewSchema.js";
import type { InlinePlacement } from "../src/agent/reviewDiffPlacement.js";

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
    vi.clearAllMocks();
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
    expect(createPullRequestReviewWithComments).toHaveBeenCalledTimes(2);
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
