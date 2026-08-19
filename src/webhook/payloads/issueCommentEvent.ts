import * as v from "valibot";
import {
  githubPrNumberSchema,
  githubSafeIdSchema,
  installationSchema,
  repositorySchema,
} from "./common.js";

export const issueCommentWebhookSchema = v.object({
  action: v.string(),
  installation: installationSchema,
  repository: repositorySchema,
  issue: v.pipe(
    v.object({
      number: githubPrNumberSchema,
      pull_request: v.unknown(),
    }),
    v.check((i) => i.pull_request != null, "issue must belong to a pull request"),
  ),
  comment: v.object({
    id: githubSafeIdSchema,
    user: v.object({
      id: githubSafeIdSchema,
      login: v.nullish(v.string()),
    }),
    author_association: v.nullish(v.string()),
    body: v.nullish(v.string()),
    /** Present when the comment is a reply in a PR conversation thread. */
    in_reply_to_id: v.nullish(githubSafeIdSchema),
  }),
});

export type IssueCommentWebhookPayload = v.InferOutput<typeof issueCommentWebhookSchema>;
