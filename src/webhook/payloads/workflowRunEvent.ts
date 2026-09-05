import * as v from "valibot";
import { installationSchema, repositorySchema } from "./common.js";
import { ciRefreshCompletedRunSchema } from "./ciRefreshHead.js";

export const workflowRunWebhookSchema = v.object({
  action: v.string(),
  installation: installationSchema,
  repository: repositorySchema,
  workflow_run: ciRefreshCompletedRunSchema,
});

export type WorkflowRunWebhookPayload = v.InferOutput<typeof workflowRunWebhookSchema>;
