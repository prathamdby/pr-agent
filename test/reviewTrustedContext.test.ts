import { describe, expect, it } from "vitest";
import { buildTrustedReviewContextForReview } from "../src/review/prompts/reviewTrustedContext.js";

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
});
