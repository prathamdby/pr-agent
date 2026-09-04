import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  REVIEW_CI_SUMMARY_LOG_MAX_JOBS,
  REVIEW_CI_SUMMARY_LOG_PER_JOB_MAX_CHARS,
  REVIEW_CI_SUMMARY_LOG_RAW_TAIL_MULTIPLE,
} from "../src/settings/index.js";

const { listWorkflowRunsForRepo, listJobsForWorkflowRun, downloadJobLogsForWorkflowRun } =
  vi.hoisted(() => ({
    listWorkflowRunsForRepo: vi.fn(),
    listJobsForWorkflowRun: vi.fn(),
    downloadJobLogsForWorkflowRun: vi.fn(),
  }));

vi.mock("../src/github/appAuth.js", () => ({
  installationOctokit: vi.fn(() => ({
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
});

describe("downloadActionsJobLogs", () => {
  it("returns the tail of a huge log and keeps the failure marker", async () => {
    const tail = "Error: Process completed with exit code 1.\nFormat issues found";
    const headSentinel = "HEAD-ONLY-SENTINEL-do-not-keep";
    const huge = `${headSentinel}\n${"z".repeat(200_000)}\n${tail}`;
    downloadJobLogsForWorkflowRun.mockResolvedValue({ data: huge });

    const downloaded = await downloadActionsJobLogs("tok", "o", "r", 9);

    expect(downloaded.ok).toBe(true);
    if (!downloaded.ok) return;
    const cap = REVIEW_CI_SUMMARY_LOG_PER_JOB_MAX_CHARS * REVIEW_CI_SUMMARY_LOG_RAW_TAIL_MULTIPLE;
    expect(downloaded.text.length).toBe(cap);
    expect(downloaded.text.endsWith(tail)).toBe(true);
    expect(downloaded.text).not.toContain(headSentinel);
  });
});
