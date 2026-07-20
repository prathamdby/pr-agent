import { z } from "zod";
import { installationSchema, repositorySchema } from "./common.js";

const workflowRunPullRequestSchema = z.object({
  number: z.number(),
  head: z.object({ sha: z.string() }),
});

export const workflowRunWebhookSchema = z.object({
  action: z.string(),
  installation: installationSchema,
  repository: repositorySchema,
  workflow_run: z.object({
    id: z.number(),
    head_sha: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
    pull_requests: z.array(workflowRunPullRequestSchema).optional().default([]),
  }),
});

export type WorkflowRunWebhookPayload = z.infer<typeof workflowRunWebhookSchema>;

/** PR numbers whose head SHA matches the workflow run head (deduped). */
export function prNumbersForWorkflowRunHead(
  headSha: string,
  pullRequests: readonly { readonly number: number; readonly head: { readonly sha: string } }[],
): number[] {
  return [...new Set(pullRequests.filter((pr) => pr.head.sha === headSha).map((pr) => pr.number))];
}
