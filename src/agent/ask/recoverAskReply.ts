import type { ReplyTarget } from "../../agentWork/types.ts";
import type { PrSurface } from "../../github/prSurface.ts";
import { findCommentIdByMarker } from "../../github/prSurfaceHelpers.ts";
import { operationIntentMarker } from "../../agentWork/publishOnce.ts";
import { isRecord } from "../../util/typeGuards.ts";
import { redactOutboundSecrets } from "../../security/redactOutboundSecrets.ts";

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
    return false;
  }
  const redactedQuestion = redactOutboundSecrets(question.trim());
  if (!redactedQuestion) return false;
  return body.includes(`**Question:** ${redactedQuestion}`) && body.includes("**Answer:**");
}

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
      ? (await prSurface.listReviewComments()).comments
      : (await prSurface.listConversationComments()).comments;

  const marker =
    operationKey != null && operationInstance != null
      ? operationIntentMarker(operationKey, operationInstance)
      : null;
  if (marker != null) {
    const commentId = findCommentIdByMarker(comments, marker, (comment) => {
      if (comment.authorLogin !== botLogin) return false;
      return (
        replyTarget.kind !== "inlineReviewThread" ||
        comment.inReplyToId === replyTarget.inReplyToCommentId
      );
    });
    if (commentId != null) {
      return { commentId, targetKind: replyTarget.kind };
    }
  }

  if (operationKey != null) return null;

  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const comment = comments[i];
    if (!comment || comment.authorLogin !== botLogin) continue;
    if (replyTarget.kind !== "prConversation") continue;
    if (!askReplyBodyMatchesQuestion(comment.body ?? "", question, replyTarget)) continue;
    return {
      commentId: comment.id,
      targetKind: replyTarget.kind,
    };
  }
  return null;
}
