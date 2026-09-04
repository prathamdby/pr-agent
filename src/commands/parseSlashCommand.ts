import { firstNonEmptyLine } from "./firstNonEmptyLine.js";

const SLASH_COMMAND_RE = /^\/([a-z0-9-]+)(?:\s|$)/;
const REVIEW_FORCE_RE = /^\/review\s+force(?:\s|$)/;
const TRIAGE_PREVIEW_RE = /^\/triage\s+preview(?:\s|$)/;
const TRIAGE_BULK_RE = /^\/triage\s+all(?:\s|$)/;

export type ParsedTriageCommand =
  | { readonly kind: "apply" }
  | { readonly kind: "preview" }
  | { readonly kind: "bulk"; readonly excludeThreadRootCommentIds: readonly number[] }
  | { readonly kind: "invalid"; readonly reason: "unknown_subcommand" | "invalid_exclude" };

export function parseSlashCommand(body: string): string | null {
  const first = firstNonEmptyLine(body);
  const m = first.match(SLASH_COMMAND_RE);
  return m?.[1] ?? null;
}

/** True when the first non-empty line is `/review force` (trailing text allowed). */
export function isReviewForceCommand(body: string): boolean {
  return REVIEW_FORCE_RE.test(firstNonEmptyLine(body));
}

/**
 * Parse `/triage` subcommands on the first non-empty line.
 * Returns null when the command token is not `triage`.
 */
export function parseTriageCommand(body: string): ParsedTriageCommand | null {
  if (parseSlashCommand(body) !== "triage") return null;
  const first = firstNonEmptyLine(body);
  if (TRIAGE_PREVIEW_RE.test(first)) return { kind: "preview" };
  if (TRIAGE_BULK_RE.test(first)) return parseTriageBulkCommand(first);
  const rest = first.replace(/^\/triage(?:\s+|$)/, "").trim();
  if (rest.length === 0) return { kind: "apply" };
  return { kind: "invalid", reason: "unknown_subcommand" };
}

function parseTriageBulkCommand(first: string): ParsedTriageCommand {
  const rest = first.replace(/^\/triage\s+all(?:\s+|$)/, "").trim();
  if (rest.length === 0) return { kind: "bulk", excludeThreadRootCommentIds: [] };
  if (!rest.startsWith("exclude")) return { kind: "invalid", reason: "unknown_subcommand" };
  if (rest !== "exclude" && !rest.startsWith("exclude ") && !rest.startsWith("exclude\t")) {
    return { kind: "invalid", reason: "unknown_subcommand" };
  }
  const idsPart = rest.slice("exclude".length).trim();
  if (idsPart.length === 0) return { kind: "invalid", reason: "invalid_exclude" };
  const tokens = idsPart.split(/[,\s]+/).filter((token) => token.length > 0);
  const ids: number[] = [];
  for (const token of tokens) {
    if (!/^[1-9][0-9]*$/.test(token)) return { kind: "invalid", reason: "invalid_exclude" };
    const id = Number(token);
    if (!Number.isSafeInteger(id)) return { kind: "invalid", reason: "invalid_exclude" };
    ids.push(id);
  }
  if (ids.length === 0) return { kind: "invalid", reason: "invalid_exclude" };
  return { kind: "bulk", excludeThreadRootCommentIds: ids };
}
