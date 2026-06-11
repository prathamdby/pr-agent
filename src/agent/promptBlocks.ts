function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function neutralizeUntrustedBlockTags(label: string, text: string): string {
  const tagPattern = new RegExp(`<\\s*/?\\s*${escapeRegExp(label)}(?=[\\s>/\\p{Cf}])[^>]*>`, "giu");
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
