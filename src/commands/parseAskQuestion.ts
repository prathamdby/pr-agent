import { MAX_ASK_QUESTION_CHARS, askQuestionTooLongHint } from "../settings/index.js";
import type { ReplyTarget } from "./replyTarget.js";
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

/**
 * Parse an ask question, including the implicit inline-thread body path:
 * when `/ask` is absent on an inline review thread reply, treat the trimmed
 * comment body as the question (same product rule for slash and classify).
 */
export function parseAskQuestionForReplyTarget(
  body: string,
  replyTarget: ReplyTarget,
): AskQuestionParseResult {
  const result = parseAskQuestionResult(body);
  if (result.kind !== "not_ask") return result;
  if (replyTarget.kind !== "inlineReviewThread") return result;

  const question = body.trim();
  if (question.length === 0) return { kind: "missing" };
  if (question.length > MAX_ASK_QUESTION_CHARS) return { kind: "too_long" };
  return { kind: "ok", question };
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
