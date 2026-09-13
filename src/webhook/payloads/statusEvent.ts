import * as v from "valibot";
import { githubShaSchema, installationSchema, repositorySchema } from "./common.js";

/** Legacy commit status. No `action` field on this event. */
export const statusWebhookSchema = v.object({
  sha: githubShaSchema,
  state: v.string(),
  context: v.string(),
  description: v.optional(v.nullable(v.string())),
  target_url: v.optional(v.nullable(v.string())),
  created_at: v.optional(v.string()),
  updated_at: v.optional(v.string()),
  installation: installationSchema,
  repository: repositorySchema,
});

export type StatusWebhookPayload = v.InferOutput<typeof statusWebhookSchema>;
