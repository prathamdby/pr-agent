import * as v from "valibot";
import { installationSchema, repositorySchema } from "./common.ts";
import { ciHeadCompletedRunSchema } from "./ciHeadSource.ts";

export const workflowRunWebhookSchema = v.object({
  action: v.string(),
  installation: installationSchema,
  repository: repositorySchema,
  workflow_run: v.object({
    ...ciHeadCompletedRunSchema.entries,
    event: v.optional(v.string()),
  }),
});

export type WorkflowRunWebhookPayload = v.InferOutput<typeof workflowRunWebhookSchema>;
