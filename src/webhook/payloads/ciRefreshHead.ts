import * as v from "valibot";
import { githubPrNumberSchema, githubSafeIdSchema, githubShaSchema } from "./common.js";

/** Shared PR association shape on workflow_run / check_suite completed payloads. */
export const ciRefreshPullRequestSchema = v.object({
  number: githubPrNumberSchema,
  head: v.object({ sha: githubShaSchema }),
});

export type CiRefreshPullRequest = v.InferOutput<typeof ciRefreshPullRequestSchema>;

/** Shared completed-run body on workflow_run and check_suite webhooks. */
export const ciRefreshCompletedRunSchema = v.object({
  id: githubSafeIdSchema,
  head_sha: githubShaSchema,
  status: v.string(),
  conclusion: v.nullable(v.string()),
  pull_requests: v.optional(v.array(ciRefreshPullRequestSchema), []),
});

export type CiRefreshHeadSource = {
  readonly installationId: number;
  readonly owner: string;
  readonly repo: string;
  readonly headSha: string;
  readonly pullRequests: readonly CiRefreshPullRequest[];
};

/** Normalize workflow_run / check_suite completed payloads into a CI refresh head. */
export function toCiRefreshHeadSource(input: {
  readonly installation: { readonly id: number };
  readonly repository: { readonly owner: { readonly login: string }; readonly name: string };
  readonly headSha: string;
  readonly pullRequests?: readonly CiRefreshPullRequest[] | null;
}): CiRefreshHeadSource {
  return {
    installationId: input.installation.id,
    owner: input.repository.owner.login,
    repo: input.repository.name,
    headSha: input.headSha,
    pullRequests: input.pullRequests ?? [],
  };
}

export function toCiRefreshHeadSourceFromCompletedRun(input: {
  readonly installation: { readonly id: number };
  readonly repository: { readonly owner: { readonly login: string }; readonly name: string };
  readonly run: {
    readonly head_sha: string;
    readonly pull_requests?: readonly CiRefreshPullRequest[] | null;
  };
}): CiRefreshHeadSource {
  return toCiRefreshHeadSource({
    installation: input.installation,
    repository: input.repository,
    headSha: input.run.head_sha,
    pullRequests: input.run.pull_requests,
  });
}

/** PR numbers whose head SHA matches the completed CI head (deduped). */
export function prNumbersForCiHead(
  headSha: string,
  pullRequests: readonly { readonly number: number; readonly head: { readonly sha: string } }[],
): number[] {
  return [...new Set(pullRequests.filter((pr) => pr.head.sha === headSha).map((pr) => pr.number))];
}
