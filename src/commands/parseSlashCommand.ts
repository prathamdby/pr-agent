import { firstNonEmptyLine } from "./firstNonEmptyLine.js";

const SLASH_COMMAND_RE = /^\/([a-z0-9-]+)(?:\s|$)/;
const REVIEW_FORCE_RE = /^\/review\s+force(?:\s|$)/;

export function parseSlashCommand(body: string): string | null {
  const first = firstNonEmptyLine(body);
  const m = first.match(SLASH_COMMAND_RE);
  return m?.[1] ?? null;
}

/** True when the first non-empty line is `/review force` (trailing text allowed). */
export function isReviewForceCommand(body: string): boolean {
  return REVIEW_FORCE_RE.test(firstNonEmptyLine(body));
}
