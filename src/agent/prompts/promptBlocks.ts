function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function neutralizeUntrustedBlockTags(label: string, text: string): string {
  const tagGap = "[\\s\\p{Cf}\\p{Cc}]*";
  const labelPattern = label.split("").map(escapeRegExp).join(tagGap);
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

export function formatHumanReplies(thread: { readonly humanReplies: readonly string[] }): string[] {
  return thread.humanReplies.flatMap((reply, index) => [
    `  Maintainer reply ${index + 1}:`,
    wrapUntrustedBlock("maintainer_reply", reply)
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n"),
  ]);
}
