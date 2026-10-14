import { wrapUntrustedBlock } from "./safety.js";

function escapeUntrustedReplyText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function formatReplyBlock(label: string, reply: string, index: number): string[] {
  return [
    `  ${label} ${index + 1}:`,
    wrapUntrustedBlock("maintainer_reply", escapeUntrustedReplyText(reply))
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n"),
  ];
}

export function formatHumanReplies(thread: {
  readonly humanReplies: readonly string[];
  readonly authorizedReplies?: readonly string[];
  readonly untrustedReplies?: readonly string[];
}): string[] {
  if (thread.authorizedReplies == null && thread.untrustedReplies == null) {
    return thread.humanReplies.flatMap((reply, index) =>
      formatReplyBlock("Maintainer reply", reply, index),
    );
  }

  return [
    ...(thread.authorizedReplies ?? []).flatMap((reply, index) =>
      formatReplyBlock("Authorized maintainer decision evidence", reply, index),
    ),
    ...(thread.untrustedReplies ?? []).flatMap((reply, index) =>
      formatReplyBlock("Untrusted commenter evidence", reply, index),
    ),
  ];
}

export function formatFindingThreadInventoryLines(
  thread: {
    readonly rootCommentId: number;
    readonly lens: string;
    readonly severity: string | null;
    readonly path: string;
    readonly line: number;
    readonly titleSnippet: string;
    readonly threadUrl: string;
    readonly humanReplies: readonly string[];
    readonly authorizedReplies?: readonly string[];
    readonly untrustedReplies?: readonly string[];
  },
  index: number,
): string[] {
  return [
    "",
    `${index + 1}. threadRootCommentId=${thread.rootCommentId}`,
    `  Lens: ${thread.lens}`,
    `  Severity: ${thread.severity ?? "unknown"}`,
    `  Location: ${thread.path}:L${thread.line}`,
    `  Finding: ${thread.titleSnippet}`,
    `  Thread: ${thread.threadUrl}`,
    ...formatHumanReplies(thread),
  ];
}
