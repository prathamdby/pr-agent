const SLASH_COMMAND_RE = /^\/([a-z0-9-]+)(?:\s|$)/;
const REVIEW_FORCE_RE = /^\/review\s+force(?:\s|$)/;
const TRIAGE_PREVIEW_RE = /^\/triage\s+preview(?:\s|$)/;
const TRIAGE_BULK_RE = /^\/triage\s+all(?:\s|$)/;

export type ParsedTriageCommand =
  | { readonly kind: "apply" }
  | { readonly kind: "preview" }
  | { readonly kind: "bulk"; readonly excludeThreadRootCommentIds: readonly number[] }
  | { readonly kind: "invalid"; readonly reason: "unknown_subcommand" | "invalid_exclude" };

export function parseSlashCommand(body: string) {
  const first = firstNonEmptyLine(body);
  const m = first.match(SLASH_COMMAND_RE);
  return ((pinnedReturn: string | null) => pinnedReturn)(m?.[1] ?? null);
}

export function isReviewForceCommand(body: string) {
  return ((pinnedReturn: boolean) => pinnedReturn)(REVIEW_FORCE_RE.test(firstNonEmptyLine(body)));
}

export function parseTriageCommand(body: string) {
  if (parseSlashCommand(body) !== "triage")
    return ((pinnedReturn: ParsedTriageCommand | null) => pinnedReturn)(null);
  const first = firstNonEmptyLine(body);
  if (TRIAGE_PREVIEW_RE.test(first))
    return ((pinnedReturn: ParsedTriageCommand | null) => pinnedReturn)({ kind: "preview" });
  if (TRIAGE_BULK_RE.test(first))
    return ((pinnedReturn: ParsedTriageCommand | null) => pinnedReturn)(
      parseTriageBulkCommand(first),
    );
  const rest = first.replace(/^\/triage(?:\s+|$)/, "").trim();
  if (rest.length === 0)
    return ((pinnedReturn: ParsedTriageCommand | null) => pinnedReturn)({ kind: "apply" });
  return ((pinnedReturn: ParsedTriageCommand | null) => pinnedReturn)({
    kind: "invalid",
    reason: "unknown_subcommand",
  });
}

function parseTriageBulkCommand(first: string) {
  const rest = first.replace(/^\/triage\s+all(?:\s+|$)/, "").trim();
  if (rest.length === 0)
    return ((pinnedReturn: ParsedTriageCommand) => pinnedReturn)({
      kind: "bulk",
      excludeThreadRootCommentIds: [],
    });
  if (!rest.startsWith("exclude"))
    return ((pinnedReturn: ParsedTriageCommand) => pinnedReturn)({
      kind: "invalid",
      reason: "unknown_subcommand",
    });
  if (rest !== "exclude" && !rest.startsWith("exclude ") && !rest.startsWith("exclude\t")) {
    return ((pinnedReturn: ParsedTriageCommand) => pinnedReturn)({
      kind: "invalid",
      reason: "unknown_subcommand",
    });
  }
  const idsPart = rest.slice("exclude".length).trim();
  if (idsPart.length === 0)
    return ((pinnedReturn: ParsedTriageCommand) => pinnedReturn)({
      kind: "invalid",
      reason: "invalid_exclude",
    });
  const tokens = idsPart.split(/[,\s]+/).filter((token) => token.length > 0);
  const ids: number[] = [];
  for (const token of tokens) {
    if (!/^[1-9][0-9]*$/.test(token))
      return ((pinnedReturn: ParsedTriageCommand) => pinnedReturn)({
        kind: "invalid",
        reason: "invalid_exclude",
      });
    const id = Number(token);
    if (!Number.isSafeInteger(id))
      return ((pinnedReturn: ParsedTriageCommand) => pinnedReturn)({
        kind: "invalid",
        reason: "invalid_exclude",
      });
    ids.push(id);
  }
  if (ids.length === 0)
    return ((pinnedReturn: ParsedTriageCommand) => pinnedReturn)({
      kind: "invalid",
      reason: "invalid_exclude",
    });
  return ((pinnedReturn: ParsedTriageCommand) => pinnedReturn)({
    kind: "bulk",
    excludeThreadRootCommentIds: ids,
  });
}

export function firstNonEmptyLine(text: string) {
  return ((pinnedReturn: string) => pinnedReturn)(text.match(/^.*\S.*$/m)?.[0] ?? "");
}
