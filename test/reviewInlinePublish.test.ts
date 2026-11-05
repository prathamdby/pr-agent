import { afterEach, describe, expect, it, vi } from "vitest";
import { publishInlineReviewComments } from "../src/review/placement/reviewInlinePublish.ts";
import type { ReviewFinding } from "../src/review/reviewSchema.ts";
import type { InlinePlacement } from "../src/review/placement/reviewDiffPlacement.ts";
import { createFakePrSurface } from "../src/github/prSurface.ts";
import type { PrSurface } from "../src/github/prSurface.ts";

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
      renderCommentBody: (placement) => placement.finding.title,
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
      renderCommentBody: (placement) => placement.finding.title,
    });

    expect(result.postedPlacements).toHaveLength(2);
    expect(result.anchorDroppedPlacements).toHaveLength(1);
    expect(result.anchorDroppedPlacements[0]?.finding.file).toBe("src/a.ts");
  });

  it("publishes the usable anchor after a path-only rejection", async () => {
    let callCount = 0;
    const prSurface = surfaceWithPublish(async () => {
      callCount += 1;
      if (callCount === 1) {
        throw Object.assign(
          new Error("Line could not be resolved and Path could not be resolved"),
          {
            status: 422,
            response: {
              status: 422,
              data: {
                message: "Validation Failed",
                errors: [
                  {
                    resource: "PullRequestReview",
                    code: "custom",
                    message: "Line could not be resolved",
                    path: "src/bad-line.ts",
                    line: 2,
                  },
                  {
                    resource: "PullRequestReview",
                    code: "custom",
                    message: "Path could not be resolved",
                    path: "src/bad-line.ts",
                  },
                ],
              },
            },
          },
        );
      }
      if (callCount === 2) {
        throw Object.assign(new Error("Path could not be resolved"), {
          status: 422,
          response: {
            status: 422,
            data: {
              message: "Validation Failed",
              errors: [
                {
                  resource: "PullRequestReview",
                  code: "custom",
                  message: "Path could not be resolved",
                  path: "src/bad-path.ts",
                },
              ],
            },
          },
        });
      }
      return { reviewId: 11, reviewUrl: "https://example.com/review/11" };
    });

    const badLine = placement(finding("P1", "src/bad-line.ts", 2));
    const badPath = placement(finding("P1", "src/bad-path.ts", 4));
    const usable = placement(finding("P2", "src/ok.ts", 8));

    const result = await publishInlineReviewComments({
      prSurface,
      renderReviewBody: () => "pointer",
      event: "COMMENT",
      commitId: "sha",
      inlinePlacements: [badLine, badPath, usable],
      renderCommentBody: (placement) => placement.finding.title,
    });

    expect(result.review?.id).toBe(11);
    expect(result.postedPlacements.map((placement) => placement.finding.file)).toEqual([
      "src/ok.ts",
    ]);
    expect(
      result.anchorDroppedPlacements.map((placement) => placement.finding.file).toSorted(),
    ).toEqual(["src/bad-line.ts", "src/bad-path.ts"]);
    expect(result.lineResolutionFallback).toBe(true);
    expect(prSurface.publishThreadBatch).toHaveBeenCalledTimes(3);
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
        renderCommentBody: (placement) => placement.finding.title,
      }),
    ).rejects.toThrow("rate limited");
  });
});
