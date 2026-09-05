import * as v from "valibot";
import { installationSchema, repositorySchema } from "./common.js";
import { ciRefreshCompletedRunSchema } from "./ciRefreshHead.js";

export const checkSuiteWebhookSchema = v.object({
  action: v.string(),
  installation: installationSchema,
  repository: repositorySchema,
  check_suite: ciRefreshCompletedRunSchema,
});

export type CheckSuiteWebhookPayload = v.InferOutput<typeof checkSuiteWebhookSchema>;
