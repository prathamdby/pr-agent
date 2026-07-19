import { MAX_ASK_QUESTION_CHARS, askQuestionTooLongHint } from "../settings/index.js";
import type { ReplyTarget } from "./replyTarget.js";
import { firstNonEmptyLine } from "./firstNonEmptyLine.js";
import { commentMentionsBot, stripBotMentions } from "./parseBotMention.js";

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

function parseMentionAskQuestion(body: string, botLogin: string): AskQuestionParseResult {
  if (!commentMentionsBot(body, botLogin)) return { kind: "not_ask" };
  const question = stripBotMentions(body, botLogin);
  if (question.length === 0) return { kind: "missing" };
  if (question.length > MAX_ASK_QUESTION_CHARS) return { kind: "too_long" };
  return { kind: "ok", question };
}

/**
 * Parse an ask question for slash `/ask` or an `@bot` mention.
 * Bare non-mention bodies are never treated as asks (conversational trigger is mention or `/ask`).
 */
export function parseAskQuestionForReplyTarget(
  body: string,
  _replyTarget: ReplyTarget,
  botLogin?: string,
): AskQuestionParseResult {
  const result = parseAskQuestionResult(body);
  if (result.kind !== "not_ask") return result;
  if (botLogin == null || botLogin.length === 0) return result;
  return parseMentionAskQuestion(body, botLogin);
}
