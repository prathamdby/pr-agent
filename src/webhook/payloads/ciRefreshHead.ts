import * as v from "valibot";
import { githubPrNumberSchema, githubShaSchema } from "./common.js";

/** Shared PR association shape on workflow_run / check_suite completed payloads. */
export const ciRefreshPullRequestSchema = v.object({
  number: githubPrNumberSchema,
  head: v.object({ sha: githubShaSchema }),
});

export type CiRefreshPullRequest = v.InferOutput<typeof ciRefreshPullRequestSchema>;

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

/** PR numbers whose head SHA matches the completed CI head (deduped). */
export function prNumbersForCiHead(
  headSha: string,
  pullRequests: readonly { readonly number: number; readonly head: { readonly sha: string } }[],
): number[] {
  return [...new Set(pullRequests.filter((pr) => pr.head.sha === headSha).map((pr) => pr.number))];
}
