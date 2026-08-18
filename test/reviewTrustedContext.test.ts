import { describe, expect, it } from "vitest";
import {
  buildTrustedReviewContextForReview,
  fetchPriorInlineFeedbackBlockForReview,
} from "../src/review/prompts/reviewTrustedContext.js";
import { createFakePrSurface } from "../src/github/prSurface.js";
import type { CheckoutCoverage } from "../src/prWorkspace/localPrWorkspace.js";

const sparseCoverage: CheckoutCoverage = {
  mode: "sparse",
  pathsInCheckout: 12,
  changedFileCount: 15,
  changeSetTruncated: false,
};

describe("buildTrustedReviewContextForReview", () => {
  it("includes agentInstructionFilesBlock in the assembled trusted context", () => {
    const preflight = {
      files: [{ filename: "src/a.ts" }],
      truncated: false,
      fileCount: 1,
      totalChanges: 5,
    };
    const block = "Trusted context (agent instruction files):\n### File `AGENTS.md`\nBe terse.";
    const result = buildTrustedReviewContextForReview({
      preflight,
      agentInstructionFilesBlock: block,
    });
    expect(result).toContain("Trusted context (agent instruction files):");
    expect(result).toContain("Be terse.");
  });

  it("omits agent instruction block when not provided", () => {
    const preflight = {
      files: [{ filename: "src/a.ts" }],
      truncated: false,
      fileCount: 1,
      totalChanges: 5,
    };
    const result = buildTrustedReviewContextForReview({ preflight });
    expect(result).not.toContain("Trusted context (agent instruction files):");
  });

  it("includes sparse checkout coverage in trusted context", () => {
    const preflight = {
      files: [{ filename: "src/a.ts" }],
      truncated: false,
      fileCount: 1,
      totalChanges: 5,
    };
    const result = buildTrustedReviewContextForReview({
      preflight,
      checkoutCoverage: sparseCoverage,
    });
    expect(result).toContain("Checkout coverage:");
    expect(result).toContain("sparse (12 paths on disk)");
    expect(result).toContain("Change set truncated: no");
  });

  it("includes symbol index status in trusted context", () => {
    const preflight = {
      files: [{ filename: "src/a.ts" }],
      truncated: false,
      fileCount: 1,
      totalChanges: 5,
    };
    const result = buildTrustedReviewContextForReview({
      preflight,
      symbolIndexStatus: { available: true, symbolCount: 42 },
    });
    expect(result).toContain("Symbol index: built for 42 symbols.");
  });
});

describe("fetchPriorInlineFeedbackBlockForReview", () => {
  it("passes the current lens through the PrSurface seam and formats the block", async () => {
    const { surface, controls } = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
    controls.setPriorInlineFeedback([
      {
        path: "src/a.ts",
        startLine: 4,
        endLine: 4,
        botTitleSnippet: "P1 · Missing await",
        humanReplies: ["False positive"],
        threadUrl: "https://github.com/o/r/pull/1#discussion_r1",
      },
    ]);

    const block = await fetchPriorInlineFeedbackBlockForReview({
      prSurface: surface,
      botUserId: 99,
      reviewLens: "review",
    });

    expect(controls.events).toContainEqual({
      kind: "fetchPriorInlineFeedback",
      botUserId: 99,
      currentLens: "review",
    });
    expect(block).toContain("Prior inline review feedback");
    expect(block).toContain("False positive");
  });

  it("carries an exact legacy lens so the seam can apply mismatch policy", async () => {
    const { surface, controls } = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
    await fetchPriorInlineFeedbackBlockForReview({
      prSurface: surface,
      botUserId: 7,
      reviewLens: "review-security",
    });
    expect(controls.events).toContainEqual({
      kind: "fetchPriorInlineFeedback",
      botUserId: 7,
      currentLens: "review-security",
    });
  });

  it("fails soft when the GitHub read throws", async () => {
    const errors: unknown[] = [];
    const { surface } = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
    surface.fetchPriorInlineFeedback = async () => {
      throw new Error("github unavailable");
    };

    const block = await fetchPriorInlineFeedbackBlockForReview({
      prSurface: surface,
      botUserId: 99,
      reviewLens: "review",
      onPriorFeedbackError: (error) => {
        errors.push(error);
      },
    });

    expect(block).toBeUndefined();
    expect(errors).toEqual([expect.objectContaining({ message: "github unavailable" })]);
  });
});
