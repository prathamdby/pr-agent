import { MAX_ASK_QUESTION_CHARS, askQuestionTooLongHint } from "../settings.js";
import { firstNonEmptyLine } from "./firstNonEmptyLine.js";

export const ASK_QUESTION_TOO_LONG_HINT = askQuestionTooLongHint();

const ASK_COMMAND_RE = /^\/ask(?:\s+(.*))?$/;

/**
 * Extract the question from `/ask ...` on the first non-empty line.
 * Supports optional surrounding quotes on the question text.
 */
function askRestFromBody(body: string): string | null {
  const first = firstNonEmptyLine(body);
  const m = first.match(ASK_COMMAND_RE);
  if (!m) return null;

  let rest = (m[1] ?? "").trim();
  if (
    (rest.startsWith('"') && rest.endsWith('"')) ||
    (rest.startsWith("'") && rest.endsWith("'"))
  ) {
    rest = rest.slice(1, -1).trim();
  }
  return rest;
}

export type AskQuestionParseResult =
  | { kind: "ok"; question: string }
  | { kind: "not_ask" }
  | { kind: "missing" }
  | { kind: "too_long" };

export function parseAskQuestionResult(body: string): AskQuestionParseResult {
  const rest = askRestFromBody(body);
  if (rest == null) return { kind: "not_ask" };
  if (rest.length === 0) return { kind: "missing" };
  if (rest.length > MAX_ASK_QUESTION_CHARS) return { kind: "too_long" };
  return { kind: "ok", question: rest };
}

export function parseAskQuestion(body: string): string | null {
  const result = parseAskQuestionResult(body);
  return result.kind === "ok" ? result.question : null;
}

export function askQuestionParseFailure(body: string): "missing" | "too_long" | null {
  const result = parseAskQuestionResult(body);
  if (result.kind === "missing" || result.kind === "too_long") return result.kind;
  return null;
}
