import { beforeEach, describe, expect, it, vi } from "vitest";
import { REVIEW_CI_SUMMARY_LOG_MAX_JOBS } from "../src/settings/index.js";

const { listWorkflowRunsForRepo, listJobsForWorkflowRun, downloadJobLogsForWorkflowRun } =
  vi.hoisted(() => ({
    listWorkflowRunsForRepo: vi.fn(),
    listJobsForWorkflowRun: vi.fn(),
    downloadJobLogsForWorkflowRun: vi.fn(),
  }));

vi.mock("../src/github/appAuth.js", () => ({
  installationOctokit: vi.fn(() => ({
    paginate: async (
      route: (params: { page?: number; per_page?: number }) => Promise<{ data?: unknown }>,
      params: { page?: number; per_page?: number },
      map?: (response: { data: unknown }, done: () => void) => unknown,
    ) => {
      const read = (raw: unknown): unknown => {
        if (Array.isArray(raw) || raw == null || typeof raw !== "object") return raw;
        if ("workflow_runs" in raw) return raw.workflow_runs;
        if ("jobs" in raw) return raw.jobs;
        if ("check_runs" in raw) return raw.check_runs;
        return raw;
      };
      if (!map) return read((await route(params))?.data);
      const perPage = params.per_page ?? 100;
      const items: unknown[] = [];
      for (let page = 1; page <= 20; page += 1) {
        let stop = false;
        const response = await route({ ...params, page });
        const data = read(response?.data);
        const pageItems = await map({ ...response, data }, () => {
          stop = true;
        });
        if (Array.isArray(pageItems)) items.push(...pageItems);
        const length = Array.isArray(data) ? data.length : 0;
        if (stop || length === 0 || length < perPage) break;
      }
      return items;
    },
    rest: {
      actions: {
        listWorkflowRunsForRepo,
        listJobsForWorkflowRun,
        downloadJobLogsForWorkflowRun,
      },
    },
  })),
}));

import {
  downloadActionsJobLogs,
  isGithubNotFoundError,
  isMissingActionsPermissionError,
  listFailingActionsJobsForHead,
} from "../src/github/actionsLogs.js";

beforeEach(() => {
  listWorkflowRunsForRepo.mockReset();
  listJobsForWorkflowRun.mockReset();
  downloadJobLogsForWorkflowRun.mockReset();
});

function workflowRun(id: number, headSha: string) {
  return { id, head_sha: headSha };
}

function job(id: number, conclusion: string) {
  return { id, name: `job-${id}`, conclusion, html_url: `https://example.com/${id}` };
}

describe("listFailingActionsJobsForHead", () => {
  it("does not treat throttling or ambiguous forbidden responses as permission denial", async () => {
    for (const error of [
      Object.assign(new Error("API rate limit exceeded"), { status: 403 }),
      Object.assign(new Error("Forbidden"), { status: 403 }),
      Object.assign(new Error("Request timeout"), { status: 504 }),
    ]) {
      listWorkflowRunsForRepo.mockRejectedValueOnce(error);
      await expect(listFailingActionsJobsForHead("tok", "o", "r", "abc")).rejects.toBe(error);
      expect(isMissingActionsPermissionError(error)).toBe(false);
    }
  });
  it("lists jobs only for the reviewed head and stops at the failing-job cap", async () => {
    const head = "abc123";
    listWorkflowRunsForRepo.mockResolvedValue({
      data: {
        workflow_runs: [
          workflowRun(1, "other"),
          workflowRun(2, head),
          workflowRun(3, "other"),
          workflowRun(4, head),
          workflowRun(5, head),
        ],
      },
    });
    listJobsForWorkflowRun.mockImplementation(async ({ run_id }: { run_id: number }) => ({
      data: {
        jobs: [job(run_id * 10, "success"), job(run_id * 10 + 1, "failure")],
      },
    }));

    const listed = await listFailingActionsJobsForHead("tok", "o", "r", head);

    expect(listed).toEqual({
      ok: true,
      jobs: [
        { id: 21, name: "job-21", conclusion: "failure", htmlUrl: "https://example.com/21" },
        { id: 41, name: "job-41", conclusion: "failure", htmlUrl: "https://example.com/41" },
        { id: 51, name: "job-51", conclusion: "failure", htmlUrl: "https://example.com/51" },
      ].slice(0, REVIEW_CI_SUMMARY_LOG_MAX_JOBS),
    });
    expect(listJobsForWorkflowRun.mock.calls.map((call) => call[0].run_id)).toEqual([2, 4, 5]);
    expect(listJobsForWorkflowRun).toHaveBeenCalledTimes(REVIEW_CI_SUMMARY_LOG_MAX_JOBS);
  });

  it("does not list jobs for extra matching runs after the failing-job cap", async () => {
    const head = "def456";
    listWorkflowRunsForRepo.mockResolvedValue({
      data: {
        workflow_runs: [
          workflowRun(10, head),
          workflowRun(11, head),
          workflowRun(12, head),
          workflowRun(13, head),
        ],
      },
    });
    listJobsForWorkflowRun.mockImplementation(async ({ run_id }: { run_id: number }) => ({
      data: {
        jobs: [job(run_id, "failure"), job(run_id + 100, "timed_out")],
      },
    }));

    const listed = await listFailingActionsJobsForHead("tok", "o", "r", head);

    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.jobs).toHaveLength(REVIEW_CI_SUMMARY_LOG_MAX_JOBS);
      expect(listed.jobs.map((item) => item.id)).toEqual([10, 110, 11]);
    }
    expect(listJobsForWorkflowRun.mock.calls.map((call) => call[0].run_id)).toEqual([10, 11]);
  });

  it("returns no jobs on 404 and permission-denied on 403", async () => {
    listWorkflowRunsForRepo.mockRejectedValueOnce(
      Object.assign(new Error("Not Found"), { status: 404 }),
    );
    await expect(listFailingActionsJobsForHead("tok", "o", "r", "abc")).resolves.toEqual({
      ok: true,
      jobs: [],
    });

    listWorkflowRunsForRepo.mockRejectedValueOnce(
      Object.assign(new Error("Resource not accessible by integration"), { status: 403 }),
    );
    await expect(listFailingActionsJobsForHead("tok", "o", "r", "abc")).resolves.toEqual({
      ok: false,
      reason: "actions_permission",
    });
  });
});

describe("downloadActionsJobLogs", () => {
  it("does not persist denial for ambiguous log-download failures", async () => {
    const error = Object.assign(new Error("API rate limit exceeded"), { status: 403 });
    downloadJobLogsForWorkflowRun.mockRejectedValueOnce(error);
    await expect(downloadActionsJobLogs("tok", "o", "r", 9)).rejects.toBe(error);
  });
  it("returns the full downloaded log and leaves bounding to the CI author", async () => {
    const headSentinel = "HEAD-ONLY-SENTINEL-do-not-drop";
    const huge = `${headSentinel}\n${"z".repeat(200_000)}\nError: Process completed with exit code 1.`;
    downloadJobLogsForWorkflowRun.mockResolvedValue({ data: huge });

    await expect(downloadActionsJobLogs("tok", "o", "r", 9)).resolves.toEqual({
      ok: true,
      text: huge,
    });
  });

  it("treats 403 as a missing Actions permission and 404 as empty logs", async () => {
    const forbidden = Object.assign(new Error("Resource not accessible by integration"), {
      status: 403,
    });
    const missing = Object.assign(new Error("Not Found"), { status: 404 });
    expect(isMissingActionsPermissionError(forbidden)).toBe(true);
    expect(isMissingActionsPermissionError(missing)).toBe(false);
    expect(isGithubNotFoundError(missing)).toBe(true);
    expect(isGithubNotFoundError(forbidden)).toBe(false);

    downloadJobLogsForWorkflowRun.mockRejectedValueOnce(forbidden);
    await expect(downloadActionsJobLogs("tok", "o", "r", 9)).resolves.toEqual({
      ok: false,
      reason: "actions_permission",
    });

    downloadJobLogsForWorkflowRun.mockRejectedValueOnce(missing);
    await expect(downloadActionsJobLogs("tok", "o", "r", 9)).resolves.toEqual({
      ok: false,
      reason: "empty",
    });
  });
});
