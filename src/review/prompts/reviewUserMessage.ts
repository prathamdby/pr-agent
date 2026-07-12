import { wrapUntrustedBlock } from "../../agent/prompts/promptBlocks.js";

export function buildReviewRunUserContent(params: {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  userSupplement?: string;
  trustedContext?: string;
}): string {
  const { owner, repo, prNumber, headSha, userSupplement, trustedContext } = params;
  return [
    `Target repository: ${owner}/${repo}`,
    `Pull request #: ${prNumber}`,
    `Head commit SHA: ${headSha}`,
    userSupplement ? `\n${wrapUntrustedBlock("user_supplement", userSupplement)}\n` : "",
    trustedContext ? `\n${trustedContext}\n` : "",
    "",
    "Perform an exhaustive review: inspect every changed file, then call submitReview exactly once with all evidenced P0–P2 findings.",
  ].join("\n");
}
