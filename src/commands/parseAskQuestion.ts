import { MAX_ASK_QUESTION_CHARS, askQuestionTooLongHint } from "../settings/index.ts";
import { firstNonEmptyLine } from "./parseSlashCommand.ts";
import { commentMentionsBot, stripBotMentions } from "./parseBotMention.ts";

export const ASK_QUESTION_TOO_LONG_HINT = askQuestionTooLongHint();

const ASK_COMMAND_RE = /^\/ask(?:\s+(.*))?$/;

function askRestFromBody(body: string) {
  const first = firstNonEmptyLine(body);
  const m = first.match(ASK_COMMAND_RE);
  if (!m) return ((pinnedReturn: string | null) => pinnedReturn)(null);

  let rest = (m[1] ?? "").trim();
  if (
    (rest.startsWith('"') && rest.endsWith('"')) ||
    (rest.startsWith("'") && rest.endsWith("'"))
  ) {
    rest = rest.slice(1, -1).trim();
  }
  return ((pinnedReturn: string | null) => pinnedReturn)(rest);
}

export type AskQuestionParseResult =
  | { kind: "ok"; question: string }
  | { kind: "not_ask" }
  | { kind: "missing" }
  | { kind: "too_long" };

function classifyAskQuestion(text: string) {
  if (text.length === 0)
    return ((pinnedReturn: AskQuestionParseResult) => pinnedReturn)({ kind: "missing" });
  if (text.length > MAX_ASK_QUESTION_CHARS)
    return ((pinnedReturn: AskQuestionParseResult) => pinnedReturn)({ kind: "too_long" });
  return ((pinnedReturn: AskQuestionParseResult) => pinnedReturn)({ kind: "ok", question: text });
}

export function parseAskQuestionResult(body: string) {
  const rest = askRestFromBody(body);
  if (rest == null)
    return ((pinnedReturn: AskQuestionParseResult) => pinnedReturn)({ kind: "not_ask" });
  return classifyAskQuestion(rest);
}

function parseMentionAskQuestion(body: string, botLogin: string) {
  if (!commentMentionsBot(body, botLogin))
    return ((pinnedReturn: AskQuestionParseResult) => pinnedReturn)({ kind: "not_ask" });
  return classifyAskQuestion(stripBotMentions(body, botLogin));
}

export function parseAskQuestion(body: string, botLogin?: string) {
  const result = parseAskQuestionResult(body);
  if (result.kind !== "not_ask")
    return ((pinnedReturn: AskQuestionParseResult) => pinnedReturn)(result);
  if (botLogin == null || botLogin.length === 0)
    return ((pinnedReturn: AskQuestionParseResult) => pinnedReturn)(result);
  return ((pinnedReturn: AskQuestionParseResult) => pinnedReturn)(
    parseMentionAskQuestion(body, botLogin),
  );
}
