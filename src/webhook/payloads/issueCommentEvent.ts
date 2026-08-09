import * as v from "valibot";
import { installationSchema, repositorySchema } from "./common.js";

export const issueCommentWebhookSchema = v.object({
  action: v.string(),
  installation: installationSchema,
  repository: repositorySchema,
  issue: v.pipe(
    v.object({
      number: v.number(),
      pull_request: v.unknown(),
    }),
    v.check((i) => i.pull_request != null, "issue must belong to a pull request"),
  ),
  comment: v.object({
    id: v.number(),
    user: v.object({
      id: v.number(),
      login: v.nullish(v.string()),
    }),
    author_association: v.nullish(v.string()),
    body: v.nullish(v.string()),
    /** Present when the comment is a reply in a PR conversation thread. */
    in_reply_to_id: v.nullish(v.number()),
  }),
});

export type IssueCommentWebhookPayload = v.InferOutput<typeof issueCommentWebhookSchema>;
