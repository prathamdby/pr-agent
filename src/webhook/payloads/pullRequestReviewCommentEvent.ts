import { z } from "zod";
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
