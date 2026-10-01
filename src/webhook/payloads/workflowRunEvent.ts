import * as v from "valibot";
import { githubSafeIdSchema, installationSchema, repositorySchema } from "./common.js";
import { ciHeadCompletedRunSchema } from "./ciHeadSource.js";

export const workflowRunWebhookSchema = v.object({
  action: v.string(),
  installation: installationSchema,
  repository: repositorySchema,
  sender: v.nullish(v.object({ id: githubSafeIdSchema, type: v.nullish(v.string()) })),
  workflow_run: v.object({
    ...ciHeadCompletedRunSchema.entries,
    event: v.nullish(v.string()),
    status: v.nullish(v.string()),
    conclusion: v.nullish(v.string()),
  }),
});

export type WorkflowRunWebhookPayload = v.InferOutput<typeof workflowRunWebhookSchema>;
