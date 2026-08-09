import * as v from "valibot";
import { installationSchema, repositorySchema } from "./common.js";

const workflowRunPullRequestSchema = v.object({
  number: v.number(),
  head: v.object({ sha: v.string() }),
});

export const workflowRunWebhookSchema = v.object({
  action: v.string(),
  installation: installationSchema,
  repository: repositorySchema,
  workflow_run: v.object({
    id: v.number(),
    head_sha: v.string(),
    status: v.string(),
    conclusion: v.nullable(v.string()),
    pull_requests: v.optional(v.array(workflowRunPullRequestSchema), []),
  }),
});

export type WorkflowRunWebhookPayload = v.InferOutput<typeof workflowRunWebhookSchema>;

/** PR numbers whose head SHA matches the workflow run head (deduped). */
export function prNumbersForWorkflowRunHead(
  headSha: string,
  pullRequests: readonly { readonly number: number; readonly head: { readonly sha: string } }[],
): number[] {
  return [...new Set(pullRequests.filter((pr) => pr.head.sha === headSha).map((pr) => pr.number))];
}
