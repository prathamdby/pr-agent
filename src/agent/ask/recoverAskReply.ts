import type { ReplyTarget } from "../../commands/replyTarget.js";
import type { PrSurface } from "../../github/prSurface.js";
import { isJsonNumber, isJsonObject, type JsonObject } from "../../util/jsonValue.js";
import { redactOutboundSecrets } from "./askSafety.js";

export type RecoveredAskReply = {
  readonly commentId: number;
};

/** Extract a stashed GitHub comment id from operation-intent detail. */
export function askReplyCommentIdFromIntentDetail(detail: JsonObject | undefined): number | null {
  if (!detail || !("__result" in detail)) return null;
  const result = detail.__result;
  if (result === undefined || !isJsonObject(result)) return null;
  const commentId = result.commentId;
  if (commentId === undefined || !isJsonNumber(commentId)) return null;
  return commentId;
}

export function askReplyBodyMatchesQuestion(
  body: string,
  question: string,
  replyTarget: ReplyTarget,
): boolean {
  if (replyTarget.kind === "inlineReviewThread") {
    // Inline replies are answer-only; shape matching is not reliable.
    return false;
  }
  const redactedQuestion = redactOutboundSecrets(question.trim());
  if (!redactedQuestion) return false;
  return body.includes(`**Question:** ${redactedQuestion}`) && body.includes("**Answer:**");
}

/**
 * When local intent/publish state is ambiguous, look for an already-posted ask
 * reply on the PR conversation before remutating or rerunning the model.
 */
export async function findExistingAskReplyComment(params: {
  readonly prSurface: PrSurface;
  readonly replyTarget: ReplyTarget;
  readonly question: string;
  readonly botLogin: string;
}): Promise<RecoveredAskReply | null> {
  const { prSurface, replyTarget, question, botLogin } = params;
  if (replyTarget.kind === "inlineReviewThread") {
    return null;
  }

  const comments = await prSurface.listConversationComments();

  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const comment = comments[i];
    if (!comment || comment.authorLogin !== botLogin) continue;
    if (!askReplyBodyMatchesQuestion(comment.body ?? "", question, replyTarget)) continue;
    return { commentId: comment.id };
  }
  return null;
}
