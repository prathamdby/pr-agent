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

export type ListFailingActionsJobsResult =
  | { readonly ok: true; readonly jobs: readonly ActionsJobSnapshot[] }
  | { readonly ok: false; readonly reason: "actions_permission" };

export type DownloadActionsJobLogsResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: "actions_permission" | "empty" };

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
 * Lists Actions jobs for workflow runs on `headSha`.
 * Reports `actions_permission` when the installation cannot read Actions.
 */
export async function listFailingActionsJobsForHead(
  token: string,
  owner: string,
  repo: string,
  headSha: string,
  expiresAtTs?: number,
): Promise<ListFailingActionsJobsResult> {
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
    return { ok: true, jobs };
  } catch (error) {
    if (isMissingActionsPermissionError(error)) {
      return { ok: false, reason: "actions_permission" };
    }
    throw error;
  }
}

/** Downloads plain-text job logs, distinguishing permission misses from empty bodies. */
export async function downloadActionsJobLogs(
  token: string,
  owner: string,
  repo: string,
  jobId: number,
  expiresAtTs?: number,
): Promise<DownloadActionsJobLogsResult> {
  const octokit = installationOctokit(token, expiresAtTs);
  try {
    const response = await octokit.rest.actions.downloadJobLogsForWorkflowRun({
      owner,
      repo,
      job_id: jobId,
    });
    const data = response.data;
    let text: string | null = null;
    if (typeof data === "string") text = data;
    else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString("utf8");
    else if (ArrayBuffer.isView(data)) {
      text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
    }
    if (text == null || text.trim().length === 0) {
      return { ok: false, reason: "empty" };
    }
    return { ok: true, text };
  } catch (error) {
    if (isMissingActionsPermissionError(error)) {
      return { ok: false, reason: "actions_permission" };
    }
    throw error;
  }
}
