import * as v from "valibot";
import type { CodeAnchor } from "../../agent/ask/askRunTypes.js";
import {
  githubPrNumberSchema,
  githubSafeIdSchema,
  installationSchema,
  repositorySchema,
} from "./common.js";

export const pullRequestReviewCommentWebhookSchema = v.object({
  action: v.string(),
  installation: installationSchema,
  repository: repositorySchema,
  pull_request: v.object({
    number: githubPrNumberSchema,
  }),
  comment: v.object({
    id: githubSafeIdSchema,
    user: v.object({
      id: githubSafeIdSchema,
      login: v.nullish(v.string()),
    }),
    author_association: v.nullish(v.string()),
    body: v.nullish(v.string()),
    in_reply_to_id: v.nullish(githubSafeIdSchema),
    pull_request_review_id: v.nullish(githubSafeIdSchema),
    path: v.optional(v.string()),
    line: v.optional(v.number()),
    start_line: v.optional(v.nullable(v.number())),
    side: v.optional(v.picklist(["LEFT", "RIGHT"])),
    diff_hunk: v.optional(v.string()),
  }),
});

export type PullRequestReviewCommentWebhookPayload = v.InferOutput<
  typeof pullRequestReviewCommentWebhookSchema
>;

export function codeAnchorFromReviewComment(
  comment: PullRequestReviewCommentWebhookPayload["comment"],
): CodeAnchor | undefined {
  if (comment.path == null || comment.line == null) return undefined;
  return {
    path: comment.path,
    line: comment.line,
    startLine: comment.start_line ?? undefined,
    side: comment.side,
    diffHunk: comment.diff_hunk,
  };
}
