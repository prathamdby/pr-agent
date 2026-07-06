import type { BotFindingThread } from "../../review/run/reviewPriorFeedback.js";
import { wrapUntrustedBlock } from "../prompts/promptBlocks.js";

type PushedCommit = {
  readonly sha: string;
  readonly subject: string;
};

function formatHumanReplies(thread: BotFindingThread): string[] {
  return thread.humanReplies.flatMap((reply, index) => [
    `  Maintainer reply ${index + 1}:`,
    wrapUntrustedBlock("maintainer_reply", reply)
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n"),
  ]);
}

export function buildVerificationUserContent(params: {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly pushedCommits: readonly PushedCommit[];
  readonly threads: readonly BotFindingThread[];
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

  lines.push("", "Prior PR Agent findings to verify:");

  params.threads.forEach((thread, index) => {
    lines.push(
      "",
      `${index + 1}. threadRootCommentId=${thread.rootCommentId}`,
      `  Lens: ${thread.lens}`,
      `  Severity: ${thread.severity ?? "unknown"}`,
      `  Location: ${thread.path}:L${thread.line}`,
      `  Finding: ${thread.titleSnippet}`,
      `  Thread: ${thread.threadUrl}`,
      ...formatHumanReplies(thread),
    );
  });

  lines.push("", "Inspect the current code, then call submitVerification once.");
  return lines.join("\n");
}
