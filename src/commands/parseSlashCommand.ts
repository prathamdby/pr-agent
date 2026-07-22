import { firstNonEmptyLine } from "./firstNonEmptyLine.js";

const SLASH_COMMAND_RE = /^\/([a-z0-9-]+)(?:\s|$)/;

export function parseSlashCommand(body: string): string | null {
  const first = firstNonEmptyLine(body);
  const m = first.match(SLASH_COMMAND_RE);
  return m?.[1] ?? null;
}
