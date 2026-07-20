import { installationOctokit } from "./appAuth.js";
import { httpStatus } from "./httpStatus.js";
import { paginateOctokitPages } from "./paginateOctokit.js";

const WORKFLOW_RUNS_PAGE_SIZE = 20;
const WORKFLOW_RUNS_MAX_PAGES = 2;
const JOBS_PAGE_SIZE = 50;
const JOBS_MAX_PAGES = 2;

export type ActionsJobSnapshot = {
  readonly id: number;
  readonly name: string;
  readonly conclusion: string | null;
  readonly htmlUrl: string | null;
};

/** True when Actions API is unavailable to this installation (missing permission or 404). */
export function isMissingActionsPermissionError(error: unknown): boolean {
  const status = httpStatus(error);
  if (status !== 403 && status !== 404) return false;
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Resource not accessible by integration") ||
    message.includes("Not Found") ||
    status === 404
  );
}

/**
 * Lists Actions jobs for workflow runs on `headSha`. Soft-fails to `[]` when Actions
 * permission is missing.
 */
export async function listFailingActionsJobsForHead(
  token: string,
  owner: string,
  repo: string,
  headSha: string,
  expiresAtTs?: number,
): Promise<ActionsJobSnapshot[]> {
  const octokit = installationOctokit(token, expiresAtTs);
  try {
    const runs = await paginateOctokitPages({
      perPage: WORKFLOW_RUNS_PAGE_SIZE,
      maxPages: WORKFLOW_RUNS_MAX_PAGES,
      fetchPage: async (page, perPage) => {
        const { data } = await octokit.rest.actions.listWorkflowRunsForRepo({
          owner,
          repo,
          head_sha: headSha,
          per_page: perPage,
          page,
        });
        return data.workflow_runs;
      },
    });

    const jobs: ActionsJobSnapshot[] = [];
    for (const run of runs) {
      if (run.head_sha !== headSha) continue;
      const runJobs = await paginateOctokitPages({
        perPage: JOBS_PAGE_SIZE,
        maxPages: JOBS_MAX_PAGES,
        fetchPage: async (page, perPage) => {
          const { data } = await octokit.rest.actions.listJobsForWorkflowRun({
            owner,
            repo,
            run_id: run.id,
            per_page: perPage,
            page,
          });
          return data.jobs;
        },
      });
      for (const job of runJobs) {
        if (job.conclusion !== "failure" && job.conclusion !== "timed_out") continue;
        jobs.push({
          id: job.id,
          name: job.name,
          conclusion: job.conclusion,
          htmlUrl: job.html_url ?? null,
        });
      }
    }
    return jobs;
  } catch (error) {
    if (isMissingActionsPermissionError(error)) return [];
    throw error;
  }
}

/**
 * Downloads plain-text job logs. Returns null when permission is missing or the API
 * returns an empty body.
 */
export async function downloadActionsJobLogs(
  token: string,
  owner: string,
  repo: string,
  jobId: number,
  expiresAtTs?: number,
): Promise<string | null> {
  const octokit = installationOctokit(token, expiresAtTs);
  try {
    const response = await octokit.rest.actions.downloadJobLogsForWorkflowRun({
      owner,
      repo,
      job_id: jobId,
    });
    const data = response.data;
    if (typeof data === "string") return data;
    if (data instanceof ArrayBuffer) {
      return Buffer.from(data).toString("utf8");
    }
    if (ArrayBuffer.isView(data)) {
      return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
    }
    return null;
  } catch (error) {
    if (isMissingActionsPermissionError(error)) return null;
    throw error;
  }
}
