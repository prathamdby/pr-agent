import * as v from "valibot";
import { githubPrNumberSchema, githubSafeIdSchema, githubShaSchema } from "./common.ts";

export const ciHeadPullRequestSchema = v.object({
  number: githubPrNumberSchema,
  head: v.object({ sha: githubShaSchema }),
});

export type CiHeadPullRequest = v.InferOutput<typeof ciHeadPullRequestSchema>;

export const ciHeadCompletedRunSchema = v.object({
  id: githubSafeIdSchema,
  head_sha: githubShaSchema,
  status: v.string(),
  conclusion: v.nullable(v.string()),
  pull_requests: v.optional(v.array(ciHeadPullRequestSchema), []),
  app: v.optional(v.object({ id: githubSafeIdSchema })),
});

export type CiHeadSource = {
  readonly installationId: number;
  readonly owner: string;
  readonly repo: string;
  readonly headSha: string;
  readonly pullRequests: readonly CiHeadPullRequest[];
};

export function toCiHeadSource(input: {
  readonly installation: { readonly id: number };
  readonly repository: { readonly owner: { readonly login: string }; readonly name: string };
  readonly headSha: string;
  readonly pullRequests?: readonly CiHeadPullRequest[] | null;
}): CiHeadSource {
  return {
    installationId: input.installation.id,
    owner: input.repository.owner.login,
    repo: input.repository.name,
    headSha: input.headSha,
    pullRequests: input.pullRequests ?? [],
  };
}

export function toCiHeadSourceFromCompletedRun(input: {
  readonly installation: { readonly id: number };
  readonly repository: { readonly owner: { readonly login: string }; readonly name: string };
  readonly run: {
    readonly head_sha: string;
    readonly pull_requests?: readonly CiHeadPullRequest[] | null;
  };
}): CiHeadSource {
  return toCiHeadSource({
    installation: input.installation,
    repository: input.repository,
    headSha: input.run.head_sha,
    pullRequests: input.run.pull_requests,
  });
}

export function prNumbersForCiHead(
  headSha: string,
  pullRequests: readonly { readonly number: number; readonly head: { readonly sha: string } }[],
): number[] {
  return [...new Set(pullRequests.filter((pr) => pr.head.sha === headSha).map((pr) => pr.number))];
}
