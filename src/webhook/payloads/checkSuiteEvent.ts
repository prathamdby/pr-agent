import * as v from "valibot";
import { installationSchema, repositorySchema } from "./common.js";

const checkSuitePullRequestSchema = v.object({
  number: v.number(),
  head: v.object({ sha: v.string() }),
});

export const checkSuiteWebhookSchema = v.object({
  action: v.string(),
  installation: installationSchema,
  repository: repositorySchema,
  check_suite: v.object({
    id: v.number(),
    head_sha: v.string(),
    status: v.string(),
    conclusion: v.nullable(v.string()),
    pull_requests: v.optional(v.array(checkSuitePullRequestSchema), []),
  }),
});

export type CheckSuiteWebhookPayload = v.InferOutput<typeof checkSuiteWebhookSchema>;
