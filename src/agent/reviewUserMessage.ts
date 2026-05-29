import type { ReviewMode } from "./reviewSchema.js";

export function buildReviewRunUserContent(params: {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  reviewMode: ReviewMode;
  userSupplement?: string;
  trustedContext?: string;
}): string {
  const { owner, repo, prNumber, headSha, reviewMode, userSupplement, trustedContext } = params;
  return [
    `Target repository: ${owner}/${repo}`,
    `Pull request #: ${prNumber}`,
    `Head commit SHA: ${headSha}`,
    userSupplement ? `\nAdditional instruction:\n${userSupplement}\n` : "",
    trustedContext ? `\n${trustedContext}\n` : "",
    "",
    closingInstructionForReviewMode(reviewMode),
  ].join("\n");
}

function closingInstructionForReviewMode(reviewMode: ReviewMode): string {
  switch (reviewMode) {
    case "review-security":
      return "Perform an exhaustive security review: inspect every changed file, then call submitReview exactly once with all evidenced P0–P2 security findings.";
    case "review-quality":
      return "Perform an exhaustive code-quality review: inspect every changed file, then call submitReview exactly once with all evidenced P0–P2 maintainability findings.";
    case "review":
      return "Perform an exhaustive review: inspect every changed file, then call submitReview exactly once with all evidenced P0–P2 findings.";
  }
  const exhaustive: never = reviewMode;
  return exhaustive;
}
