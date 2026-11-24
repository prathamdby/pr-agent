import type { RestEndpointMethodTypes } from "@octokit/rest";
import {
  isConfirmedCapabilityDenial,
  type ReviewCapabilityPolicy,
} from "./installationCapabilities.ts";
import { classifyGithubError } from "./githubErrors.ts";
import { installationOctokit } from "./appAuth.ts";
import { stopPaginatedPage } from "./paginateOctokit.ts";
import { CHECK_RUNS_MAX_PAGES, CHECK_RUNS_PAGE_SIZE } from "../settings/index.ts";
import type { CiCheckRunSnapshot, CiLegacyStatus, CiSourceAccess } from "../review/ci/ciFacts.ts";

type CombinedCommitStatus =
  RestEndpointMethodTypes["repos"]["getCombinedStatusForRef"]["response"]["data"];
type CombinedCommitStatusItem = CombinedCommitStatus["statuses"][number];

function isCombinedCommitStatus(
  data: CombinedCommitStatus | readonly CombinedCommitStatusItem[],
): data is CombinedCommitStatus {
  return !Array.isArray(data) && "statuses" in data;
}

function combinedCommitStatusItems(
  data: CombinedCommitStatus | readonly CombinedCommitStatusItem[],
) {
  if (isCombinedCommitStatus(data))
    return ((pinnedReturn: readonly CombinedCommitStatusItem[]) => pinnedReturn)(data.statuses);
  return ((pinnedReturn: readonly CombinedCommitStatusItem[]) => pinnedReturn)(data);
}

export type CheckRunsForHeadResult = {
  readonly checkRuns: CiCheckRunSnapshot[];
  readonly truncated: boolean;
};

async function listCheckRunsForHead(
  token: string,
  owner: string,
  repo: string,
  headSha: string,
  expiresAtTs?: number,
) {
  const octokit = installationOctokit(token, expiresAtTs);
  const checkPage = { page: 0, truncated: false };
  const runs = await octokit.paginate(
    octokit.rest.checks.listForRef,
    {
      owner,
      repo,
      ref: headSha,
      filter: "latest",
      per_page: CHECK_RUNS_PAGE_SIZE,
    },
    (response, done) =>
      stopPaginatedPage(checkPage, response.data, CHECK_RUNS_PAGE_SIZE, CHECK_RUNS_MAX_PAGES, done),
  );
  const truncated = checkPage.truncated;

  return ((pinnedReturn: CheckRunsForHeadResult | Promise<CheckRunsForHeadResult>) => pinnedReturn)(
    {
      truncated,
      checkRuns: runs
        .filter((run) => run.head_sha === headSha)
        .map((run) => ({
          id: run.id,
          name: run.name,
          externalId: run.external_id ?? null,
          appId: run.app?.id ?? null,
          status: run.status,
          conclusion: run.conclusion ?? null,
          htmlUrl: run.html_url ?? null,
          startedAt: run.started_at ?? null,
          completedAt: run.completed_at ?? null,
        })),
    },
  );
}

export async function listPullsForHead(
  token: string,
  owner: string,
  repo: string,
  headSha: string,
  expiresAtTs?: number,
) {
  const octokit = installationOctokit(token, expiresAtTs);
  const pullPage = { page: 0, truncated: false };
  const pulls = await octokit.paginate(
    octokit.rest.repos.listPullRequestsAssociatedWithCommit,
    { owner, repo, commit_sha: headSha, per_page: 100 },
    (response, done) => stopPaginatedPage(pullPage, response.data, 100, 2, done),
  );
  return ((
    pinnedReturn:
      | readonly { readonly number: number }[]
      | Promise<readonly { readonly number: number }[]>,
  ) => pinnedReturn)(pulls.map((pull) => ({ number: pull.number })));
}

export async function listLegacyCommitStatusesForHeadDetailed(
  token: string,
  owner: string,
  repo: string,
  headSha: string,
  expiresAtTs?: number,
) {
  const octokit = installationOctokit(token, expiresAtTs);
  const statusPage = { page: 0, truncated: false };
  const statuses = await octokit.paginate(
    octokit.rest.repos.getCombinedStatusForRef,
    { owner, repo, ref: headSha, per_page: CHECK_RUNS_PAGE_SIZE },
    (response, done) =>
      stopPaginatedPage(
        statusPage,
        combinedCommitStatusItems(response.data),
        CHECK_RUNS_PAGE_SIZE,
        CHECK_RUNS_MAX_PAGES,
        done,
      ),
  );
  return ((
    pinnedReturn:
      | { readonly legacyStatuses: CiLegacyStatus[]; readonly truncated: boolean }
      | Promise<{ readonly legacyStatuses: CiLegacyStatus[]; readonly truncated: boolean }>,
  ) => pinnedReturn)({
    truncated: statusPage.truncated,
    legacyStatuses: statuses.map((status) => ({
      context: status.context,
      state: status.state,
      description: status.description ?? null,
      targetUrl: status.target_url ?? null,
      updatedAt: status.updated_at ?? null,
      createdAt: status.created_at ?? null,
    })),
  });
}

export type CiStatusSourceResult = {
  readonly access: CiSourceAccess;
  readonly complete: boolean;
};
export type CiStatusSourcesResult = {
  readonly checkRuns: readonly CiCheckRunSnapshot[];
  readonly legacyStatuses: readonly CiLegacyStatus[];
  readonly checkRunsComplete: boolean;
  readonly legacyStatusesComplete: boolean;
  readonly sources: {
    readonly checks: CiStatusSourceResult;
    readonly statuses: CiStatusSourceResult;
  };
};

export async function readCiStatusSources(params: {
  readonly token: string;
  readonly owner: string;
  readonly repo: string;
  readonly headSha: string;
  readonly expiresAtTs?: number;
  readonly capabilityPolicy?: ReviewCapabilityPolicy;
}) {
  const read = async <T>(
    operation: "checksRead" | "statusesRead",
    fetch: () => Promise<{ readonly items: T[]; readonly complete: boolean }>,
  ) => {
    const access = params.capabilityPolicy?.access(operation) ?? "available";
    if (access === "denied")
      return ((
        pinnedReturn:
          | { readonly items: T[]; readonly source: CiStatusSourceResult }
          | Promise<{ readonly items: T[]; readonly source: CiStatusSourceResult }>,
      ) => pinnedReturn)({ items: [], source: { access, complete: false } });
    try {
      const result = await fetch();
      return ((
        pinnedReturn:
          | { readonly items: T[]; readonly source: CiStatusSourceResult }
          | Promise<{ readonly items: T[]; readonly source: CiStatusSourceResult }>,
      ) => pinnedReturn)({
        items: result.items,
        source: { access: "available", complete: result.complete },
      });
    } catch (error) {
      if (isConfirmedCapabilityDenial(error)) {
        await params.capabilityPolicy?.deny(operation);
        return ((
          pinnedReturn:
            | { readonly items: T[]; readonly source: CiStatusSourceResult }
            | Promise<{ readonly items: T[]; readonly source: CiStatusSourceResult }>,
        ) => pinnedReturn)({ items: [], source: { access: "denied", complete: false } });
      }
      if (classifyGithubError(error) === "rate_limit") throw error;
      return ((
        pinnedReturn:
          | { readonly items: T[]; readonly source: CiStatusSourceResult }
          | Promise<{ readonly items: T[]; readonly source: CiStatusSourceResult }>,
      ) => pinnedReturn)({ items: [], source: { access: "unknown", complete: false } });
    }
  };
  const checks = await read("checksRead", async () => {
    const result = await listCheckRunsForHead(
      params.token,
      params.owner,
      params.repo,
      params.headSha,
      params.expiresAtTs,
    );
    return { items: result.checkRuns, complete: !result.truncated };
  });
  const statuses = await read("statusesRead", async () => {
    const result = await listLegacyCommitStatusesForHeadDetailed(
      params.token,
      params.owner,
      params.repo,
      params.headSha,
      params.expiresAtTs,
    );
    return { items: result.legacyStatuses, complete: !result.truncated };
  });
  return ((pinnedReturn: CiStatusSourcesResult | Promise<CiStatusSourcesResult>) => pinnedReturn)({
    checkRuns: checks.items,
    legacyStatuses: statuses.items,
    checkRunsComplete: checks.source.complete,
    legacyStatusesComplete: statuses.source.complete,
    sources: { checks: checks.source, statuses: statuses.source },
  });
}
