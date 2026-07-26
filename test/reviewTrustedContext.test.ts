import { describe, expect, it } from "vitest";
import { buildTrustedReviewContextForReview } from "../src/review/prompts/reviewTrustedContext.js";
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
