import { z } from "zod";
import { installationSchema, repositorySchema } from "./common.js";

export const pullRequestWebhookSchema = z.object({
  action: z.string(),
  installation: installationSchema,
  repository: repositorySchema,
  before: z.string().optional(),
  pull_request: z.object({
    number: z.number(),
    head: z.object({
      sha: z.string(),
    }),
    merged: z.boolean().optional().default(false),
  }),
});

export type PullRequestWebhookPayload = z.infer<typeof pullRequestWebhookSchema>;
