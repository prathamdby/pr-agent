import { isMissingActionsPermissionError } from "./actionsLogs.js";
import { installationOctokit } from "./appAuth.js";
import { paginateOctokitPages } from "./paginateOctokit.js";
import type {
  CiCheckAnnotation,
  CiCheckRunSnapshot,
  CiLegacyStatus,
} from "../review/ci/ciSummaryTypes.js";

const CHECK_RUNS_PAGE_SIZE = 100;
const CHECK_RUNS_MAX_PAGES = 5;
const ANNOTATIONS_PAGE_SIZE = 50;
const ANNOTATIONS_MAX_PAGES = 2;

export const isMissingChecksPermissionError = isMissingActionsPermissionError;

async function listCheckRunsForHeadFromGithub(
  token: string,
  owner: string,
  repo: string,
  headSha: string,
  expiresAtTs?: number,
): Promise<CiCheckRunSnapshot[]> {
  const octokit = installationOctokit(token, expiresAtTs);
  const runs = await paginateOctokitPages({
    perPage: CHECK_RUNS_PAGE_SIZE,
    maxPages: CHECK_RUNS_MAX_PAGES,
    fetchPage: async (page, perPage) => {
      const { data } = await octokit.rest.checks.listForRef({
        owner,
        repo,
        ref: headSha,
        filter: "latest",
        per_page: perPage,
        page,
      });
      return data.check_runs;
    },
  });

  return runs
    .filter((run) => run.head_sha === headSha)
    .map((run) => ({
      id: run.id,
      name: run.name,
      status: run.status,
      conclusion: run.conclusion ?? null,
      htmlUrl: run.html_url ?? null,
      outputTitle: run.output?.title ?? null,
      outputSummary: run.output?.summary ?? null,
      outputText: run.output?.text ?? null,
    }));
}

async function listCheckRunAnnotationsFromGithub(
  token: string,
  owner: string,
  repo: string,
  checkRunId: number,
  expiresAtTs?: number,
): Promise<CiCheckAnnotation[]> {
  const octokit = installationOctokit(token, expiresAtTs);
  const annotations = await paginateOctokitPages({
    perPage: ANNOTATIONS_PAGE_SIZE,
    maxPages: ANNOTATIONS_MAX_PAGES,
    fetchPage: async (page, perPage) => {
      const { data } = await octokit.rest.checks.listAnnotations({
        owner,
        repo,
        check_run_id: checkRunId,
        per_page: perPage,
        page,
      });
      return data;
    },
  });

  return annotations.map((annotation) => ({
    path: annotation.path,
    startLine: annotation.start_line ?? null,
    endLine: annotation.end_line ?? null,
    title: annotation.title ?? null,
    message: annotation.message ?? "",
    annotationLevel: annotation.annotation_level ?? "notice",
  }));
}

async function listLegacyCommitStatusesForHeadFromGithub(
  token: string,
  owner: string,
  repo: string,
  headSha: string,
  expiresAtTs?: number,
): Promise<CiLegacyStatus[]> {
  const octokit = installationOctokit(token, expiresAtTs);
  try {
    const { data } = await octokit.rest.repos.getCombinedStatusForRef({
      owner,
      repo,
      ref: headSha,
    });
    return data.statuses.map((status) => ({
      context: status.context,
      state: status.state,
      description: status.description ?? null,
      targetUrl: status.target_url ?? null,
    }));
  } catch (error) {
    if (error instanceof Error && isMissingChecksPermissionError(error)) return [];
    throw error;
  }
}

export type CiStatusQueries = {
  readonly listCheckRunsForHead: typeof listCheckRunsForHeadFromGithub;
  readonly listCheckRunAnnotations: typeof listCheckRunAnnotationsFromGithub;
  readonly listLegacyCommitStatusesForHead: typeof listLegacyCommitStatusesForHeadFromGithub;
};

const githubCiStatusQueries: CiStatusQueries = {
  listCheckRunsForHead: listCheckRunsForHeadFromGithub,
  listCheckRunAnnotations: listCheckRunAnnotationsFromGithub,
  listLegacyCommitStatusesForHead: listLegacyCommitStatusesForHeadFromGithub,
};

let activeCiStatusQueries: CiStatusQueries = githubCiStatusQueries;

export function setCiStatusQueries(queries: CiStatusQueries): void {
  activeCiStatusQueries = queries;
}

export function resetCiStatusQueries(): void {
  activeCiStatusQueries = githubCiStatusQueries;
}

export async function listCheckRunsForHead(
  ...args: Parameters<typeof listCheckRunsForHeadFromGithub>
): ReturnType<typeof listCheckRunsForHeadFromGithub> {
  return activeCiStatusQueries.listCheckRunsForHead(...args);
}

export async function listCheckRunAnnotations(
  ...args: Parameters<typeof listCheckRunAnnotationsFromGithub>
): ReturnType<typeof listCheckRunAnnotationsFromGithub> {
  return activeCiStatusQueries.listCheckRunAnnotations(...args);
}

export async function listLegacyCommitStatusesForHead(
  ...args: Parameters<typeof listLegacyCommitStatusesForHeadFromGithub>
): ReturnType<typeof listLegacyCommitStatusesForHeadFromGithub> {
  return activeCiStatusQueries.listLegacyCommitStatusesForHead(...args);
}
