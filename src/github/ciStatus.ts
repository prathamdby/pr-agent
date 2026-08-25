import { isMissingActionsPermissionError } from "./actionsLogs.js";
import { installationOctokit } from "./appAuth.js";
import { paginateOctokitPages, paginateOctokitPagesWithMeta } from "./paginateOctokit.js";
import { CHECK_RUNS_MAX_PAGES, CHECK_RUNS_PAGE_SIZE } from "../settings/index.js";
import type {
  CiCheckAnnotation,
  CiCheckRunSnapshot,
  CiLegacyStatus,
} from "../review/ci/ciSummaryTypes.js";

const ANNOTATIONS_PAGE_SIZE = 50;
const ANNOTATIONS_MAX_PAGES = 2;

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
  const { items: runs, truncated } = await paginateOctokitPagesWithMeta({
    perPage: CHECK_RUNS_PAGE_SIZE,
    maxPages: CHECK_RUNS_MAX_PAGES,
    fetchPage: async (page, perPage) => {
      const { data } = await octokit.rest.checks.listForRef({
        owner,
        repo,
        ref: headSha,
        filter: "all",
        per_page: perPage,
        page,
      });
      return data.check_runs;
    },
  });

  return {
    truncated,
    checkRuns: runs
      .filter((run) => run.head_sha === headSha)
      .map((run) => ({
        id: run.id,
        name: run.name,
        externalId: run.external_id ?? null,
        status: run.status,
        conclusion: run.conclusion ?? null,
        htmlUrl: run.html_url ?? null,
        outputTitle: run.output?.title ?? null,
        outputSummary: run.output?.summary ?? null,
        outputText: run.output?.text ?? null,
      })),
  };
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
