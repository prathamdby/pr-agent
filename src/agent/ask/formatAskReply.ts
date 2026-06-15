import type { ReplyTarget } from "../../commands/replyTarget.js";
import { redactOutboundSecrets } from "./askSafety.js";

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
}): string {
  const answer = sanitizeAskAnswerText(params.answer);
  if (params.replyTarget.kind === "inlineReviewThread") {
    return answer;
  }
  return [`**Question:** ${params.question.trim()}`, "", "**Answer:**", "", answer].join("\n");
}

export function formatAskFailureReply(params: {
  question: string;
  message: string;
  replyTarget: ReplyTarget;
}): string {
  return formatAskReply({
    question: params.question,
    answer: params.message,
    replyTarget: params.replyTarget,
  });
}
