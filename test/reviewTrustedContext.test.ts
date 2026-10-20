import { buildReviewSizeBudget } from "../src/review/run/reviewSizeBudget.ts";
import { buildReviewPathProfile } from "../src/review/placement/reviewPathProfile.ts";
import { describe, expect, it } from "vitest";
import { buildAskSystemPrompt } from "../src/prompts/ask/prompt.ts";
import { descriptionSystemPrompt } from "../src/prompts/description/prompt.ts";
import { triageSystemPrompt } from "../src/prompts/triage/prompt.ts";
import { buildTrustedReviewContextForReview } from "../src/prompts/orchestrator/prompt.ts";
import { fetchPriorInlineFeedbackBlockForReview } from "../src/review/run/reviewTrustedContext.ts";
import { renderRepoPolicyBlock } from "../src/review/repoPolicy.ts";
import { createFakePrSurface } from "../src/github/prSurface.ts";
import { REVIEW_POINTER_BODY } from "../src/settings/index.ts";
import { LEGACY_REVIEW_POINTER_BODIES } from "../src/settings/legacyReviewLenses.ts";
import type { CheckoutCoverage } from "../src/prWorkspace/repositoryReader.ts";

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
      pathProfile: buildReviewPathProfile(preflight.files.map((file) => file.filename)),
      sizeBudget: buildReviewSizeBudget(preflight),
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
    const result = buildTrustedReviewContextForReview({
      pathProfile: buildReviewPathProfile(preflight.files.map((file) => file.filename)),
      sizeBudget: buildReviewSizeBudget(preflight),
    });
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
      pathProfile: buildReviewPathProfile(preflight.files.map((file) => file.filename)),
      sizeBudget: buildReviewSizeBudget(preflight),
      repoPolicyBlock: renderRepoPolicyBlock({ policy }),
    });
    expect(trusted).toContain("Trusted context (repo policy):");
    expect(trusted).toContain("These rules are binding for this review.");

    const trustedAgain = buildTrustedReviewContextForReview({
      pathProfile: buildReviewPathProfile(preflight.files.map((file) => file.filename)),
      sizeBudget: buildReviewSizeBudget(preflight),
      repoPolicyBlock: renderRepoPolicyBlock({ policy }),
    });
    expect(trustedAgain).toContain("Trusted context (repo policy):");
    expect(trustedAgain).toContain("Never suppress security findings.");
  });

  it("includes sparse checkout coverage in trusted context", () => {
    const preflight = {
      files: [{ filename: "src/a.ts" }],
      truncated: false,
      fileCount: 1,
      totalChanges: 5,
    };
    const result = buildTrustedReviewContextForReview({
      pathProfile: buildReviewPathProfile(preflight.files.map((file) => file.filename)),
      sizeBudget: buildReviewSizeBudget(preflight),
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
      pathProfile: buildReviewPathProfile(preflight.files.map((file) => file.filename)),
      sizeBudget: buildReviewSizeBudget(preflight),
      symbolIndexStatus: { available: true, symbolCount: 42 },
    });
    expect(result).toContain("Symbol index: built for 42 symbols.");
  });

  it("keeps ask, describe, and triage free of a binding policy block", () => {
    for (const prompt of [buildAskSystemPrompt(), descriptionSystemPrompt, triageSystemPrompt]) {
      expect(prompt).not.toContain("Trusted context (repo policy)");
      expect(prompt).not.toContain("Trusted context (agent instruction files)");
      expect(prompt).not.toContain("proposed_policy_change");
    }
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
        authorLogin: "pr-agent[bot]",
        body: "**P1** · **Missing await**",
      },
      {
        ...base,
        id: 2,
        inReplyToId: 1,
        userId: 7,
        authorAssociation: "OWNER",
        authorType: "User",
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
    controls.setThreads(new Map([[1, { threadNodeId: "PRRT_1", isResolved: false }]]));
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
