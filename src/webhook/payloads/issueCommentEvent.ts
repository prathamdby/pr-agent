import { z } from "zod";
import { installationSchema, repositorySchema } from "./common.js";

export const issueCommentWebhookSchema = z.object({
  action: z.string(),
  installation: installationSchema,
  repository: repositorySchema,
  issue: z
    .object({
      number: z.number(),
      pull_request: z.unknown(),
    })
    .refine((i) => i.pull_request != null, {
      message: "issue must belong to a pull request",
    }),
  comment: z.object({
    id: z.number(),
    user: z.object({
      id: z.number(),
      login: z.string().nullish(),
    }),
    author_association: z.string().nullish(),
    body: z.string().nullish(),
    /** Present when the comment is a reply in a PR conversation thread. */
    in_reply_to_id: z.number().nullish(),
  }),
});

export type IssueCommentWebhookPayload = z.infer<typeof issueCommentWebhookSchema>;
