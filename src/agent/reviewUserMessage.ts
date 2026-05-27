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
    reviewMode === "review-security"
      ? "Perform an exhaustive security review: inspect every changed file, then call submitReview exactly once with all evidenced P0–P2 security findings."
      : "Perform an exhaustive review: inspect every changed file, then call submitReview exactly once with all evidenced P0–P2 findings.",
  ].join("\n");
}
