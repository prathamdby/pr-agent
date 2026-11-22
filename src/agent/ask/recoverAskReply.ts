import type { ReplyTarget } from "../../agentWork/types.ts";
import type { PrSurface } from "../../github/prSurface.ts";
import { findCommentIdByMarker } from "../../github/prSurfaceHelpers.ts";
import { operationIntentMarker } from "../../state/featurePublication.ts";
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
) {
  return ((pinnedReturn: string) => pinnedReturn)(
    `${operationIntentMarker(operationKey, operationInstance)}\n${body}`,
  );
}

export function askReplyCommentIdFromIntentResult(result: unknown) {
  if (!isRecord(result)) return ((pinnedReturn: number | null) => pinnedReturn)(null);
  return ((pinnedReturn: number | null) => pinnedReturn)(
    typeof result.commentId === "number" ? result.commentId : null,
  );
}

export function askReplyBodyMatchesQuestion(
  body: string,
  question: string,
  replyTarget: ReplyTarget,
) {
  if (replyTarget.kind === "inlineReviewThread") {
    return ((pinnedReturn: boolean) => pinnedReturn)(false);
  }
  const redactedQuestion = redactOutboundSecrets(question.trim());
  if (!redactedQuestion) return ((pinnedReturn: boolean) => pinnedReturn)(false);
  return ((pinnedReturn: boolean) => pinnedReturn)(
    body.includes(`**Question:** ${redactedQuestion}`) && body.includes("**Answer:**"),
  );
}

export async function findExistingAskReplyComment(params: {
  readonly prSurface: PrSurface;
  readonly replyTarget: ReplyTarget;
  readonly question: string;
  readonly botLogin: string;
  readonly operationKey?: string;
  readonly operationInstance?: string;
}) {
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
      return ((pinnedReturn: (RecoveredAskReply | null) | Promise<RecoveredAskReply | null>) =>
        pinnedReturn)({ commentId, targetKind: replyTarget.kind });
    }
  }

  if (operationKey != null)
    return ((pinnedReturn: (RecoveredAskReply | null) | Promise<RecoveredAskReply | null>) =>
      pinnedReturn)(null);

  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const comment = comments[i];
    if (!comment || comment.authorLogin !== botLogin) continue;
    if (replyTarget.kind !== "prConversation") continue;
    if (!askReplyBodyMatchesQuestion(comment.body ?? "", question, replyTarget)) continue;
    return ((pinnedReturn: (RecoveredAskReply | null) | Promise<RecoveredAskReply | null>) =>
      pinnedReturn)({
      commentId: comment.id,
      targetKind: replyTarget.kind,
    });
  }
  return ((pinnedReturn: (RecoveredAskReply | null) | Promise<RecoveredAskReply | null>) =>
    pinnedReturn)(null);
}
