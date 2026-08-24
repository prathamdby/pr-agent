import type { ReplyTarget } from "../../commands/replyTarget.js";
import type { PrSurface } from "../../github/prSurface.js";
import { operationIntentMarker } from "../../agentWork/withOperationIntent.js";
import { isRecord } from "../../util/typeGuards.js";
import { redactOutboundSecrets } from "./askSafety.js";

export type RecoveredAskReply = {
  readonly commentId: number;
  readonly targetKind: ReplyTarget["kind"];
};

export function askReplyBodyWithOperationMarker(
  body: string,
  operationKey: string,
  operationInstance: string,
): string {
  return `${operationIntentMarker(operationKey, operationInstance)}\n${body}`;
}

/** Extract a stashed GitHub comment id from operation-intent detail. */
export function askReplyCommentIdFromIntentDetail(
  detail: Record<string, unknown> | undefined,
): number | null {
  if (!detail || !("__result" in detail)) return null;
  const result = detail.__result;
  if (!isRecord(result)) return null;
  return typeof result.commentId === "number" ? result.commentId : null;
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

function hasOperationMarker(
  body: string,
  operationKey: string,
  operationInstance: string,
): boolean {
  return body.includes(operationIntentMarker(operationKey, operationInstance));
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
  readonly operationKey?: string;
  readonly operationInstance?: string;
}): Promise<RecoveredAskReply | null> {
  const { prSurface, replyTarget, question, botLogin, operationKey, operationInstance } = params;

  const comments =
    replyTarget.kind === "inlineReviewThread"
      ? await prSurface.listInlineReviewComments()
      : await prSurface.listConversationComments();

  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const comment = comments[i];
    if (!comment || comment.authorLogin !== botLogin) continue;
    if (
      replyTarget.kind === "inlineReviewThread" &&
      comment.inReplyToId !== replyTarget.inReplyToCommentId
    ) {
      continue;
    }
    const exactMarker =
      operationKey != null &&
      operationInstance != null &&
      hasOperationMarker(comment.body ?? "", operationKey, operationInstance);
    const legacyConversationMatch =
      operationKey == null &&
      replyTarget.kind === "prConversation" &&
      askReplyBodyMatchesQuestion(comment.body ?? "", question, replyTarget);
    if (!exactMarker && !legacyConversationMatch) continue;
    return {
      commentId: comment.id,
      targetKind: replyTarget.kind,
    };
  }
  return null;
}
