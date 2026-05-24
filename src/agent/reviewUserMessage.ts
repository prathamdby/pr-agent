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
      ? "Perform a deep security review of the PR diff using investigation tools, then call submitReview exactly once with a complete ReviewPayload."
      : "Perform a full review using investigation tools, then call submitReview exactly once with a complete ReviewPayload.",
  ].join("\n");
}
