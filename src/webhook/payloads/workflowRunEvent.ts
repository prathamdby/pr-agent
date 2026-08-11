import * as v from "valibot";
import { installationSchema, repositorySchema } from "./common.js";
import { ciRefreshPullRequestSchema } from "./ciRefreshHead.js";

export const workflowRunWebhookSchema = v.object({
  action: v.string(),
  installation: installationSchema,
  repository: repositorySchema,
  workflow_run: v.object({
    id: v.number(),
    head_sha: v.string(),
    status: v.string(),
    conclusion: v.nullable(v.string()),
    pull_requests: v.optional(v.array(ciRefreshPullRequestSchema), []),
  }),
});

export type WorkflowRunWebhookPayload = v.InferOutput<typeof workflowRunWebhookSchema>;
