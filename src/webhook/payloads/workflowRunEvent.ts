import * as v from "valibot";
import { installationSchema, repositorySchema } from "./common.js";
import { ciHeadCompletedRunSchema } from "./ciHeadSource.js";

export const workflowRunWebhookSchema = v.object({
  action: v.string(),
  installation: installationSchema,
  repository: repositorySchema,
  workflow_run: ciHeadCompletedRunSchema,
});

export type WorkflowRunWebhookPayload = v.InferOutput<typeof workflowRunWebhookSchema>;
