import * as v from "valibot";
import { installationSchema, repositorySchema } from "./common.js";
import { ciHeadCompletedRunSchema } from "./ciHeadSource.js";

export const checkSuiteWebhookSchema = v.object({
  action: v.string(),
  installation: installationSchema,
  repository: repositorySchema,
  check_suite: ciHeadCompletedRunSchema,
});

export type CheckSuiteWebhookPayload = v.InferOutput<typeof checkSuiteWebhookSchema>;
