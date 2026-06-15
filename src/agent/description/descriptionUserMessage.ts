import { wrapUntrustedBlock } from "../prompts/promptBlocks.js";

export function buildDescriptionUserContent(params: {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  userSupplement?: string;
}): string {
  const { owner, repo, prNumber, headSha, userSupplement } = params;
  return [
    `Target repository: ${owner}/${repo}`,
    `Pull request #: ${prNumber}`,
    `Head commit SHA: ${headSha}`,
    userSupplement ? `\n${wrapUntrustedBlock("user_supplement", userSupplement)}\n` : "",
    "",
    "Inspect the changed files and diff, then call submitDescription once with a complete DescriptionPayload.",
  ].join("\n");
}
