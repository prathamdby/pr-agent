import type { BotFindingThread } from "../../review/run/reviewPriorFeedback.js";
import { formatFindingThreadInventoryLines } from "../prompts/promptBlocks.js";

type PushedCommit = {
  readonly sha: string;
  readonly subject: string;
};

export function buildVerificationUserContent(params: {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly pushedCommits: readonly PushedCommit[];
  readonly threads: readonly BotFindingThread[];
  /** When true, GitHub compare file membership is incomplete (300-file cap). */
  readonly compareFilesTruncated?: boolean;
}): string {
  const lines = [
    `Target repository: ${params.owner}/${params.repo}`,
    `Pull request #: ${params.prNumber}`,
    `Head commit SHA: ${params.headSha}`,
  ];

  if (params.pushedCommits.length > 0) {
    lines.push("", "Pushed commits in this update:");
    for (const commit of params.pushedCommits) {
      lines.push(`- ${commit.sha} ${commit.subject}`);
    }
  }

  if (params.compareFilesTruncated) {
    lines.push(
      "",
      "Note: the push compare file list is truncated (GitHub returns at most 300 files).",
      "Treat changed-file membership as incomplete; do not assume omitted paths were untouched.",
    );
  }

  lines.push("", "Prior PR Agent findings to verify:");

  params.threads.forEach((thread, index) => {
    lines.push(...formatFindingThreadInventoryLines(thread, index));
  });

  lines.push("", "Inspect the current code, then call submitVerification once.");
  return lines.join("\n");
}
