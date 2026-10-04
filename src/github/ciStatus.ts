import { isMissingActionsPermissionError } from "./actionsLogs.js";
import {
  isConfirmedCapabilityDenial,
  type ReviewCapabilityPolicy,
} from "./installationCapabilities.js";
import { classifyGithubError } from "./githubErrors.js";
import { installationOctokit } from "./appAuth.js";
import { paginateOctokitPagesWithMeta, stopPaginatedPage } from "./paginateOctokit.js";
import { CHECK_RUNS_MAX_PAGES, CHECK_RUNS_PAGE_SIZE } from "../settings/index.js";
import type { CiCheckRunSnapshot, CiLegacyStatus, CiSourceAccess } from "../review/ci/ciFacts.js";

export const isMissingChecksPermissionError = isMissingActionsPermissionError;

export type CheckRunsForHeadResult = {
  readonly checkRuns: CiCheckRunSnapshot[];
  readonly truncated: boolean;
};

export async function listCheckRunsForHead(
  token: string,
  owner: string,
  repo: string,
  headSha: string,
  expiresAtTs?: number,
): Promise<CheckRunsForHeadResult> {
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

  return {
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
        outputTitle: run.output?.title ?? null,
        outputSummary: run.output?.summary ?? null,
        outputText: run.output?.text ?? null,
        startedAt: run.started_at ?? null,
        completedAt: run.completed_at ?? null,
      })),
  };
}

export async function listPullsForHead(
  token: string,
  owner: string,
  repo: string,
  headSha: string,
  expiresAtTs?: number,
): Promise<readonly { readonly number: number }[]> {
  const octokit = installationOctokit(token, expiresAtTs);
  const pullPage = { page: 0, truncated: false };
  const pulls = await octokit.paginate(
    octokit.rest.repos.listPullRequestsAssociatedWithCommit,
    { owner, repo, commit_sha: headSha, per_page: 100 },
    (response, done) => stopPaginatedPage(pullPage, response.data, 100, 2, done),
  );
  return pulls.map((pull) => ({ number: pull.number }));
}

export async function listLegacyCommitStatusesForHeadDetailed(
  token: string,
  owner: string,
  repo: string,
  headSha: string,
  expiresAtTs?: number,
): Promise<{ readonly legacyStatuses: CiLegacyStatus[]; readonly truncated: boolean }> {
  const octokit = installationOctokit(token, expiresAtTs);
  const { items, truncated } = await paginateOctokitPagesWithMeta({
    perPage: CHECK_RUNS_PAGE_SIZE,
    maxPages: CHECK_RUNS_MAX_PAGES,
    fetchPage: async (page, perPage) => {
      const { data } = await octokit.rest.repos.getCombinedStatusForRef({
        owner,
        repo,
        ref: headSha,
        page,
        per_page: perPage,
      });
      return data.statuses;
    },
  });
  return {
    truncated,
    legacyStatuses: items.map((status) => ({
      context: status.context,
      state: status.state,
      description: status.description ?? null,
      targetUrl: status.target_url ?? null,
      updatedAt: status.updated_at ?? null,
      createdAt: status.created_at ?? null,
    })),
  };
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

/** Independent read boundaries: a denied source is never a successful empty listing. */
export async function readCiStatusSources(params: {
  readonly token: string;
  readonly owner: string;
  readonly repo: string;
  readonly headSha: string;
  readonly expiresAtTs?: number;
  readonly capabilityPolicy?: ReviewCapabilityPolicy;
}): Promise<CiStatusSourcesResult> {
  const read = async <T>(
    operation: "checksRead" | "statusesRead",
    fetch: () => Promise<{ readonly items: T[]; readonly complete: boolean }>,
  ): Promise<{ readonly items: T[]; readonly source: CiStatusSourceResult }> => {
    const access = params.capabilityPolicy?.access(operation) ?? "available";
    if (access === "denied") return { items: [], source: { access, complete: false } };
    try {
      const result = await fetch();
      return { items: result.items, source: { access: "available", complete: result.complete } };
    } catch (error) {
      if (isConfirmedCapabilityDenial(error)) {
        await params.capabilityPolicy?.deny(operation);
        return { items: [], source: { access: "denied", complete: false } };
      }
      // Throttling retains the shared-circuit retry path. Other incomplete reads
      // are source-local so the successful sibling can still contribute facts.
      if (classifyGithubError(error) === "rate_limit") throw error;
      return { items: [], source: { access: "unknown", complete: false } };
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
  return {
    checkRuns: checks.items,
    legacyStatuses: statuses.items,
    checkRunsComplete: checks.source.complete,
    legacyStatusesComplete: statuses.source.complete,
    sources: { checks: checks.source, statuses: statuses.source },
  };
}
