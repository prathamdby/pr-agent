import { z } from "zod";
import type { CodeAnchor } from "../../agent/ask/askRunTypes.js";
import { installationSchema, repositorySchema } from "./common.js";

export const pullRequestReviewCommentWebhookSchema = z.object({
  action: z.string(),
  installation: installationSchema,
  repository: repositorySchema,
  pull_request: z.object({
    number: z.number(),
  }),
  comment: z.object({
    id: z.number(),
    user: z.object({
      id: z.number(),
    }),
    author_association: z.string().nullish(),
    body: z.string().nullish(),
    in_reply_to_id: z.number().nullish(),
    pull_request_review_id: z.number().nullish(),
    path: z.string().optional(),
    line: z.number().optional(),
    start_line: z.number().nullable().optional(),
    side: z.enum(["LEFT", "RIGHT"]).optional(),
    diff_hunk: z.string().optional(),
  }),
});

export type PullRequestReviewCommentWebhookPayload = z.infer<
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
