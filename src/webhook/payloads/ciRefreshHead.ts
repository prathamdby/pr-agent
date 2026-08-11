import * as v from "valibot";

/** Shared PR association shape on workflow_run / check_suite completed payloads. */
export const ciRefreshPullRequestSchema = v.object({
  number: v.number(),
  head: v.object({ sha: v.string() }),
});

export type CiRefreshPullRequest = v.InferOutput<typeof ciRefreshPullRequestSchema>;

export type CiRefreshHeadSource = {
  readonly installationId: number;
  readonly owner: string;
  readonly repo: string;
  readonly headSha: string;
  readonly pullRequests: readonly CiRefreshPullRequest[];
};

/** PR numbers whose head SHA matches the completed CI head (deduped). */
export function prNumbersForCiHead(
  headSha: string,
  pullRequests: readonly { readonly number: number; readonly head: { readonly sha: string } }[],
): number[] {
  return [...new Set(pullRequests.filter((pr) => pr.head.sha === headSha).map((pr) => pr.number))];
}
