import * as v from "valibot";
import { ciHeadPullRequestSchema } from "./ciHeadSource.ts";
import {
  githubSafeIdSchema,
  githubShaSchema,
  installationSchema,
  repositorySchema,
} from "./common.ts";

export const checkRunBodySchema = v.object({
  id: githubSafeIdSchema,
  head_sha: githubShaSchema,
  status: v.string(),
  conclusion: v.nullable(v.string()),
  name: v.string(),
  html_url: v.optional(v.nullable(v.string())),
  started_at: v.optional(v.nullable(v.string())),
  completed_at: v.optional(v.nullable(v.string())),
  external_id: v.optional(v.nullable(v.string())),
  app: v.optional(v.object({ id: githubSafeIdSchema })),
  pull_requests: v.optional(v.array(ciHeadPullRequestSchema), []),
});

export const checkRunWebhookSchema = v.object({
  action: v.string(),
  installation: installationSchema,
  repository: repositorySchema,
  check_run: checkRunBodySchema,
});

export type CheckRunWebhookPayload = v.InferOutput<typeof checkRunWebhookSchema>;
