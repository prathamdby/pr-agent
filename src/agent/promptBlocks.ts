export function wrapUntrustedBlock(label: string, text: string): string {
  return [`<${label} untrusted="true">`, text.trim(), `</${label}>`].join("\n");
}

export function wrapTrustedContext(lines: string[]): string {
  return ['<context trusted="server">', ...lines, "</context>"].join("\n");
}
