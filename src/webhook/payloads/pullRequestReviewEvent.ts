import * as v from "valibot";
import {
  githubPrNumberSchema,
  githubSafeIdSchema,
  githubShaSchema,
  githubUserSchema,
  installationSchema,
  repositorySchema,
} from "./common.js";

/**
 * Minimal shape for the `pull_request_review` webhook event. Only `submitted`
 * reviews are accepted at parse time; approval gating additionally requires
 * `review.state === "approved"` from a reviewer with standing.
 */
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

/** True only for a submitted approving review (dismissed/changes-requested/commented excluded). */
export function isApprovalReview(data: PullRequestReviewWebhookPayload): boolean {
  return data.action === "submitted" && data.review.state.toLowerCase() === "approved";
}
