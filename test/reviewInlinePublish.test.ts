import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishInlineReviewComments } from "../src/review/placement/reviewInlinePublish.js";
import type { ReviewFinding } from "../src/review/reviewSchema.js";
import type { InlinePlacement } from "../src/review/placement/reviewDiffPlacement.js";
import { createFakePrSurface } from "../src/github/prSurface.js";
import type { PrSurface } from "../src/github/prSurface.js";

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

function surfaceWithPublish(publishImpl: PrSurface["publishThreadBatch"]): PrSurface {
  const { surface } = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
  vi.spyOn(surface, "publishThreadBatch").mockImplementation(publishImpl);
  return surface;
}

describe("publishInlineReviewComments", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops failing anchor and publishes the rest", async () => {
    let callCount = 0;
    const prSurface = surfaceWithPublish(async () => {
      callCount += 1;
      if (callCount === 1) throw new Error("Line could not be resolved");
      return { reviewId: 9, reviewUrl: "https://example.com/review/9" };
    });

    const p1 = placement(finding("P1", "src/a.ts", 1));
    const p2 = placement(finding("P2", "src/b.ts", 2));

    const result = await publishInlineReviewComments({
      prSurface,
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
    expect(prSurface.publishThreadBatch).toHaveBeenCalledTimes(2);
  });

  it("drops the hinted failing anchor when GitHub identifies it", async () => {
    let callCount = 0;
    const prSurface = surfaceWithPublish(async () => {
      callCount += 1;
      if (callCount === 1) {
        throw {
          message: "Line could not be resolved",
          response: { data: { errors: [{ path: "src/a.ts", line: 1 }] } },
        };
      }
      return { reviewId: 9, reviewUrl: "https://example.com/review/9" };
    });

    const p1 = placement(finding("P1", "src/a.ts", 1));
    const p2 = placement(finding("P2", "src/b.ts", 2));
    const p3 = placement(finding("P3", "src/c.ts", 3));

    const result = await publishInlineReviewComments({
      prSurface,
      renderReviewBody: () => "pointer",
      event: "COMMENT",
      commitId: "sha",
      inlinePlacements: [p1, p2, p3],
      renderCommentBody: (f) => f.title,
    });

    expect(result.postedPlacements).toHaveLength(2);
    expect(result.anchorDroppedPlacements).toHaveLength(1);
    expect(result.anchorDroppedPlacements[0]?.finding.file).toBe("src/a.ts");
  });

  it("rethrows non-line-resolution errors", async () => {
    const prSurface = surfaceWithPublish(async () => {
      throw new Error("rate limited");
    });

    await expect(
      publishInlineReviewComments({
        prSurface,
        renderReviewBody: () => "pointer",
        event: "COMMENT",
        inlinePlacements: [placement(finding("P1", "src/a.ts", 1))],
        renderCommentBody: (f) => f.title,
      }),
    ).rejects.toThrow("rate limited");
  });
});
