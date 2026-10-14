import * as v from "valibot";
import {
  githubPrNumberSchema,
  githubSafeIdSchema,
  githubShaSchema,
  githubUserSchema,
  installationSchema,
  repositorySchema,
} from "./common.js";

export const pullRequestReviewWebhookSchema = v.object({
  action: v.string(),
  installation: installationSchema,
  repository: repositorySchema,
  pull_request: v.object({
    number: githubPrNumberSchema,
    head: v.object({
      sha: githubShaSchema,
    }),
  }),
  review: v.object({
    id: githubSafeIdSchema,
    state: v.string(),
    user: v.object({
      ...githubUserSchema.entries,
      type: v.optional(v.string()),
    }),
    author_association: v.nullish(v.string()),
  }),
});

export type PullRequestReviewWebhookPayload = v.InferOutput<typeof pullRequestReviewWebhookSchema>;

export function isApprovalReview(data: PullRequestReviewWebhookPayload): boolean {
  return data.action === "submitted" && data.review.state.toLowerCase() === "approved";
}
