/**
 * First meaningful line must start with `/command` (plan: case-sensitive token).
 */
const LINE_SPLIT_RE = /\r?\n/;
const SLASH_COMMAND_RE = /^\/([a-z0-9-]+)(?:\s|$)/;

export function parseSlashCommand(body: string): string | null {
  const lines = body.split(LINE_SPLIT_RE);
  const first = lines.find((l) => l.trim().length > 0) ?? "";
  const m = first.match(SLASH_COMMAND_RE);
  return m?.[1] ?? null;
}
