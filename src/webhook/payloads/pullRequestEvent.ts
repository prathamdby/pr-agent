import * as v from "valibot";
import { installationSchema, repositorySchema } from "./common.js";

export const pullRequestWebhookSchema = v.object({
  action: v.string(),
  installation: installationSchema,
  repository: repositorySchema,
  before: v.optional(v.string()),
  pull_request: v.object({
    number: v.number(),
    head: v.object({
      sha: v.string(),
    }),
    merged: v.optional(v.boolean(), false),
  }),
});

export type PullRequestWebhookPayload = v.InferOutput<typeof pullRequestWebhookSchema>;
