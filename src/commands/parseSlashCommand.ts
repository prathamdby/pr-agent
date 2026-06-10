import { firstNonEmptyLine } from "./firstNonEmptyLine.js";

/**
 * First meaningful line must start with `/command` (plan: case-sensitive token).
 */
const SLASH_COMMAND_RE = /^\/([a-z0-9-]+)(?:\s|$)/;

export function parseSlashCommand(body: string): string | null {
  const first = firstNonEmptyLine(body);
  const m = first.match(SLASH_COMMAND_RE);
  return m?.[1] ?? null;
}
