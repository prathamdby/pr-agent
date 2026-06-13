import type { BotFindingThread } from "../review/reviewPriorFeedback.js";
import { wrapUntrustedBlock } from "./promptBlocks.js";

function formatHumanReplies(thread: BotFindingThread): string[] {
  return thread.humanReplies.flatMap((reply, index) => [
    `  Maintainer reply ${index + 1}:`,
    wrapUntrustedBlock("maintainer_reply", reply)
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n"),
  ]);
}

export function buildTriageUserContent(params: {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly maxFixesPerRun: number;
  readonly threads: readonly BotFindingThread[];
}): string {
  const lines = [
    `Target repository: ${params.owner}/${params.repo}`,
    `Pull request #: ${params.prNumber}`,
    `Head commit SHA: ${params.headSha}`,
    `Fix budget: ${params.maxFixesPerRun}`,
    "",
    "Prior PR Agent findings to triage:",
  ];

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

  lines.push("", "Use the writable workspace tools, then call submitTriage once.");
  return lines.join("\n");
}
