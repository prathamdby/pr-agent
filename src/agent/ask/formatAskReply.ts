import type { ReplyTarget } from "../../commands/replyTarget.js";
import { redactOutboundSecrets } from "../../security/redactOutboundSecrets.js";
import { ASK_TRUNCATED_NOTICE } from "../../settings/index.js";

/** Prevent model output lines from being parsed as slash commands by GitHub. */
export function sanitizeAskAnswerText(text: string): string {
  let out = redactOutboundSecrets(text.trim());
  out = out.replace(/\n\//g, "\n /");
  out = out.replace(/\r\//g, "\r /");
  if (out.startsWith("/")) out = ` ${out}`;
  return out;
}

export function formatAskReply(params: {
  question: string;
  answer: string;
  replyTarget: ReplyTarget;
  truncated?: boolean;
}): string {
  const sanitized = sanitizeAskAnswerText(params.answer);
  const answer = params.truncated ? `${sanitized}\n\n${ASK_TRUNCATED_NOTICE}` : sanitized;
  if (params.replyTarget.kind === "inlineReviewThread") {
    return answer;
  }
  const question = redactOutboundSecrets(params.question.trim());
  return [`**Question:** ${question}`, "", "**Answer:**", "", answer].join("\n");
}
