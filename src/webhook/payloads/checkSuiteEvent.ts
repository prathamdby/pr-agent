import * as v from "valibot";
import {
  githubSafeIdSchema,
  githubShaSchema,
  installationSchema,
  repositorySchema,
} from "./common.js";
import { ciRefreshPullRequestSchema } from "./ciRefreshHead.js";

export const checkSuiteWebhookSchema = v.object({
  action: v.string(),
  installation: installationSchema,
  repository: repositorySchema,
  check_suite: v.object({
    id: githubSafeIdSchema,
    head_sha: githubShaSchema,
    status: v.string(),
    conclusion: v.nullable(v.string()),
    pull_requests: v.optional(v.array(ciRefreshPullRequestSchema), []),
  }),
});

export type CheckSuiteWebhookPayload = v.InferOutput<typeof checkSuiteWebhookSchema>;
