function neutralizeUntrustedBlockTags(label: string, text: string): string {
  const tagGap = "[\\s\\p{Cf}\\p{Cc}]*";
  const labelPattern = label
    .split("")
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(tagGap);
  const tagPattern = new RegExp(
    `<${tagGap}/?${tagGap}${labelPattern}(?=[\\s>/\\p{Cf}\\p{Cc}])[^>]*>`,
    "giu",
  );
  return text.replace(tagPattern, (tag) => tag.replaceAll("<", "&lt;").replaceAll(">", "&gt;"));
}

export function wrapUntrustedBlock(label: string, text: string): string {
  return [
    `<${label} untrusted="true">`,
    neutralizeUntrustedBlockTags(label, text.trim()),
    `</${label}>`,
  ].join("\n");
}

export function wrapTrustedContext(lines: string[]): string {
  return ['<context trusted="server">', ...lines, "</context>"].join("\n");
}

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
  // Keep hand-built prompt fixtures useful while production data always carries
  // explicit authorized and untrusted partitions from the server.
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
