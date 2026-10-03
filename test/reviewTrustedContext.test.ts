import { describe, expect, it } from "vitest";
import {
  buildTrustedReviewContextForReview,
  fetchPriorInlineFeedbackBlockForReview,
} from "../src/review/prompts/reviewTrustedContext.js";
import { renderRepoPolicyBlock } from "../src/review/repoPolicy.js";
import { createFakePrSurface } from "../src/github/prSurface.js";
import { REVIEW_POINTER_BODY } from "../src/settings/index.js";
import { LEGACY_REVIEW_POINTER_BODIES } from "../src/settings/legacyReviewLenses.js";
import type { CheckoutCoverage } from "../src/prWorkspace/repositoryReader.js";

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

  it("assembles trusted and untrusted repo policy blocks without changing their labels", () => {
    const preflight = {
      files: [{ filename: "src/a.ts" }],
      truncated: false,
      fileCount: 1,
      totalChanges: 5,
    };
    const policy = {
      rules: [
        {
          filename: "security.mdc",
          relativePath: ".pr-agent/security.mdc",
          alwaysApply: true,
          globs: [],
          body: "Never suppress security findings.",
        },
      ],
    };

    const trusted = buildTrustedReviewContextForReview({
      preflight,
      repoPolicyBlock: renderRepoPolicyBlock({ policy, sameRepo: true }),
    });
    expect(trusted).toContain("Trusted context (repo policy):");
    expect(trusted).toContain("These rules are binding for this review.");

    const untrusted = buildTrustedReviewContextForReview({
      preflight,
      repoPolicyBlock: renderRepoPolicyBlock({ policy, sameRepo: false }),
    });
    expect(untrusted).toContain("Untrusted context (repo policy from PR head):");
    expect(untrusted).not.toContain("Trusted context (repo policy):");
    expect(untrusted).not.toMatch(/\bbinding for this review\b/i);
    expect(untrusted).toContain("Never suppress security findings.");
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
  function seedThread(
    controls: ReturnType<typeof createFakePrSurface>["controls"],
    pointerBody: string,
    path: string,
  ) {
    controls.setPullRequestReviews([
      { id: 100, userId: 99, authorLogin: null, body: pointerBody, commitId: null, htmlUrl: "" },
    ]);
    const base = {
      pullRequestReviewId: null,
      authorLogin: "someone",
      path,
      line: 4,
      originalLine: 4,
      htmlUrl: "https://github.com/o/r/pull/1#discussion_r1",
    };
    controls.setReviewComments([
      {
        ...base,
        id: 1,
        inReplyToId: null,
        pullRequestReviewId: 100,
        userId: 99,
        body: "**P1** · **Missing await**",
      },
      {
        ...base,
        id: 2,
        inReplyToId: 1,
        userId: 7,
        authorAssociation: "OWNER",
        body: "False positive",
      },
      {
        ...base,
        id: 3,
        inReplyToId: 1,
        userId: 8,
        authorAssociation: "NONE",
        body: "ordinary commenter text",
      },
    ]);
  }

  it("reads the raw review listings and formats the block with maintainer authority", async () => {
    const { surface, controls } = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
    seedThread(controls, REVIEW_POINTER_BODY, "src/a.ts");

    const block = await fetchPriorInlineFeedbackBlockForReview({
      prSurface: surface,
      botUserId: 99,
      reviewLens: "review",
      maintainerDecisionAssociations: new Set(["OWNER", "MEMBER", "COLLABORATOR"]),
    });

    expect(block).toContain("Prior inline review feedback");
    expect(block).toContain("Authorized maintainer decision (user-provided):");
    expect(block).toContain("False positive");
    expect(block).toContain("ordinary commenter text");
  });

  it("applies the exact legacy lens mismatch policy", async () => {
    const { surface, controls } = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
    seedThread(controls, LEGACY_REVIEW_POINTER_BODIES[1], "src/a.ts");
    await expect(
      fetchPriorInlineFeedbackBlockForReview({
        prSurface: surface,
        botUserId: 7,
        reviewLens: "review-security",
      }),
    ).resolves.toBeUndefined();
    await expect(
      fetchPriorInlineFeedbackBlockForReview({
        prSurface: surface,
        botUserId: 99,
        reviewLens: "review-security",
      }),
    ).resolves.toBeUndefined();
    await expect(
      fetchPriorInlineFeedbackBlockForReview({
        prSurface: surface,
        botUserId: 99,
        reviewLens: "review-quality",
      }),
    ).resolves.toContain("src/a.ts");
  });

  it("fails soft when the GitHub read throws", async () => {
    const errors: unknown[] = [];
    const { surface } = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
    surface.listReviewComments = async () => {
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
