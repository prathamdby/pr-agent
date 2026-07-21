import { wrapUntrustedBlock } from "../../agent/prompts/promptBlocks.js";
import type { AnyReviewLens } from "../../settings/legacyReviewLenses.js";

export function buildReviewRunUserContent(params: {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  reviewMode: AnyReviewLens;
  userSupplement?: string;
  trustedContext?: string;
}): string {
  const { owner, repo, prNumber, headSha, reviewMode, userSupplement, trustedContext } = params;
  return [
    `Target repository: ${owner}/${repo}`,
    `Pull request #: ${prNumber}`,
    `Head commit SHA: ${headSha}`,
    userSupplement ? `\n${wrapUntrustedBlock("user_supplement", userSupplement)}\n` : "",
    trustedContext ? `\n${trustedContext}\n` : "",
    "",
    closingInstructionForReviewMode(reviewMode),
  ].join("\n");
}

function closingInstructionForReviewMode(reviewMode: AnyReviewLens): string {
  switch (reviewMode) {
    case "review-security":
      return "Perform an exhaustive security review: inspect every changed file, then call submitReview exactly once with all evidenced P0–P2 security findings.";
    case "review-quality":
      return "Perform an exhaustive code-quality review: inspect every changed file, then call submitReview exactly once with all evidenced P0–P2 maintainability findings.";
    case "review-tests":
      return "Perform an exhaustive test-gap review: inspect every changed file, then call submitReview exactly once with all evidenced P0–P2 proposed test cases.";
    case "review":
      return "Perform an exhaustive review: inspect every changed file, then call submitReview exactly once with all evidenced P0–P2 findings.";
  }
  const exhaustive: never = reviewMode;
  return exhaustive;
}
