import { installationOctokit } from "./appAuth.js";
import { httpStatus } from "./httpStatus.js";
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

/** True when Checks API is unavailable to this installation (missing permission or 404). */
export function isMissingChecksPermissionError(error: unknown): boolean {
  const status = httpStatus(error);
  if (status !== 403 && status !== 404) return false;
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Resource not accessible by integration") ||
    message.includes("Not Found") ||
    status === 404
  );
}

export async function listCheckRunsForHead(
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

export async function listCheckRunAnnotations(
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

export async function listLegacyCommitStatusesForHead(
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
    if (isMissingChecksPermissionError(error)) return [];
    throw error;
  }
}
