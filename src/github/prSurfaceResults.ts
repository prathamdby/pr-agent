import * as v from "valibot";
import type { PrSurfaceMutationMethods } from "./prSurfaceTypes.ts";

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

export function decodePublishedBatch(value: unknown) {
  v.assert(publishedBatchSchema, value);
  return value;
}

export function decodeVoidResult(value: unknown) {
  v.assert(v.void(), value);
}

export function decodePrSurfaceMutationResult(
  method: keyof PrSurfaceMutationMethods,
  value: unknown,
) {
  switch (method) {
    case "replyAt":
      return ((pinnedReturn: unknown) => pinnedReturn)(decodePostedReply(value));
    case "upsertProgressComment":
      return ((pinnedReturn: unknown) => pinnedReturn)(decodeProgressComment(value));
    case "startReviewCheck":
      return ((pinnedReturn: unknown) => pinnedReturn)(decodeCheckRef(value));
    case "publishThreadBatch":
      return ((pinnedReturn: unknown) => pinnedReturn)(decodePublishedBatch(value));
    case "updatePullRequest":
      v.assert(pullRequestUpdateSchema, value);
      return ((pinnedReturn: unknown) => pinnedReturn)(value);
    case "editReviewComment":
      v.assert(v.boolean(), value);
      return ((pinnedReturn: unknown) => pinnedReturn)(value);
    case "setAcknowledgementReaction":
    case "editComment":
    case "setReviewCommitStatus":
    case "dismissPullRequestReview":
    case "resolveInlineReviewThread":
    case "setLabels":
    case "finishReviewCheck":
      return ((pinnedReturn: unknown) => pinnedReturn)(decodeVoidResult(value));
    default: {
      const exhaustive: never = method;
      return ((pinnedReturn: unknown) => pinnedReturn)(exhaustive);
    }
  }
}
