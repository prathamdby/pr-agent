import * as v from "valibot";
import type { PrSurfaceMutationMethods } from "./prSurfaceTypes.js";

const postedReplySchema = v.object({ commentId: v.number() });
const progressCommentSchema = v.object({ id: v.number(), updated: v.boolean() });
const checkRefSchema = v.object({ id: v.number(), url: v.nullable(v.string()) });
const publishedBatchSchema = v.object({ reviewId: v.number(), reviewUrl: v.string() });
const pullRequestUpdateSchema = v.object({ prNumber: v.number() });

export function decodePostedReply(value: unknown) {
  v.assert(postedReplySchema, value);
  return value;
}

export function decodeProgressComment(value: unknown) {
  v.assert(progressCommentSchema, value);
  return value;
}

export function decodeCheckRef(value: unknown) {
  v.assert(checkRefSchema, value);
  return value;
}

export function decodeVoidResult(value: unknown): void {
  v.assert(v.void(), value);
}

/** Validate without parsing or replacing the provider's original result. */
export function decodePrSurfaceMutationResult(
  method: keyof PrSurfaceMutationMethods,
  value: unknown,
): unknown {
  switch (method) {
    case "replyAt":
      return decodePostedReply(value);
    case "upsertProgressComment":
      return decodeProgressComment(value);
    case "startReviewCheck":
      return decodeCheckRef(value);
    case "publishThreadBatch":
      v.assert(publishedBatchSchema, value);
      return value;
    case "updatePullRequest":
      v.assert(pullRequestUpdateSchema, value);
      return value;
    case "editReviewComment":
      v.assert(v.boolean(), value);
      return value;
    case "setAcknowledgementReaction":
    case "editComment":
    case "setReviewCommitStatus":
    case "resolveInlineReviewThread":
    case "setLabels":
    case "finishReviewCheck":
      return decodeVoidResult(value);
    default: {
      const exhaustive: never = method;
      return exhaustive;
    }
  }
}
