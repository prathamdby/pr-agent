import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ListFailingActionsJobsResult } from "../src/github/actionsLogs.js";

const {
  listCheckRunsForHead,
  listLegacyCommitStatusesForHead,
  isMissingChecksPermissionError,
  listFailingActionsJobsForHead,
  downloadActionsJobLogs,
} = vi.hoisted(() => ({
  listCheckRunsForHead: vi.fn(),
  listLegacyCommitStatusesForHead: vi.fn(),
  isMissingChecksPermissionError: vi.fn((_error?: unknown) => false),
  listFailingActionsJobsForHead: vi.fn(
    async (): Promise<ListFailingActionsJobsResult> => ({ ok: true, jobs: [] }),
  ),
  downloadActionsJobLogs: vi.fn(),
}));

vi.mock("../src/github/ciStatus.js", () => ({
  listCheckRunsForHead,
  listCheckRunAnnotations: vi.fn(async () => []),
  listLegacyCommitStatusesForHead,
  isMissingChecksPermissionError,
}));

vi.mock("../src/github/actionsLogs.js", () => ({
  listFailingActionsJobsForHead,
  downloadActionsJobLogs,
}));

import {
  buildCiSummaryForSurface,
  isOwnCiCheckName,
  summarizeCiSnapshot,
} from "../src/review/ci/analyzeCi.js";
import { createFakePrSurface } from "../src/github/prSurface.js";

function ciSurface() {
  return createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 }, { credentialToken: "t" })
    .surface;
}

async function buildCiSummary(
  options: Parameters<typeof buildCiSummaryForSurface>[1] & { headSha: string },
) {
  return buildCiSummaryForSurface(ciSurface(), options);
}
import type { CiSummaryAuthor } from "../src/review/ci/authorCiSummary.js";

const mockAuthor: CiSummaryAuthor = async (input) => ({
  headline: `❌ CI failing — ${input.failingNames.join(", ")}`,
  failures: input.failingNames.map((name) => ({
    name,
    reason: input.condensedLogs.includes("Format issues")
      ? "Format issues found; run oxfmt to fix."
      : input.condensedLogs.slice(0, 120) || "Check failed.",
    fixHint: "Fix the reported failure locally, then re-push.",
  })),
});

describe("analyzeCi", () => {
  beforeEach(() => {
    listCheckRunsForHead.mockReset();
    listLegacyCommitStatusesForHead.mockReset();
    isMissingChecksPermissionError.mockReset();
    isMissingChecksPermissionError.mockReturnValue(false);
    listFailingActionsJobsForHead.mockReset();
    downloadActionsJobLogs.mockReset();
    listFailingActionsJobsForHead.mockResolvedValue({ ok: true, jobs: [] });
  });

  it("recognizes PR Agent owned check names", () => {
    expect(isOwnCiCheckName("PR Agent Review")).toBe(true);
    expect(isOwnCiCheckName("PR Agent Security Review")).toBe(true);
    expect(isOwnCiCheckName("lint")).toBe(false);
  });

  it("summarizes all-passing checks", () => {
    const summary = summarizeCiSnapshot({
      checks: [
        {
          id: 1,
          name: "lint",
          status: "completed",
          conclusion: "success",
          htmlUrl: "https://example.com/1",
          outputTitle: null,
          outputSummary: null,
          outputText: null,
        },
      ],
      statuses: [],
    });
    expect(summary.status).toBe("passing");
    expect(summary.headline).toContain("All CI is passing");
    expect(summary.headline).toContain("✅");
  });

  it("summarizes pending checks", () => {
    const summary = summarizeCiSnapshot({
      checks: [
        {
          id: 1,
          name: "lint",
          status: "in_progress",
          conclusion: null,
          htmlUrl: null,
          outputTitle: null,
          outputSummary: null,
          outputText: null,
        },
      ],
      statuses: [],
    });
    expect(summary.status).toBe("pending");
    expect(summary.headline).toContain("still running");
  });

  it("authors failing CI from condensed logs via injected author", async () => {
    listCheckRunsForHead.mockResolvedValueOnce([
      {
        id: 10,
        name: "PR Agent Review",
        status: "in_progress",
        conclusion: null,
        htmlUrl: null,
        outputTitle: null,
        outputSummary: null,
        outputText: null,
      },
      {
        id: 11,
        name: "lint",
        status: "completed",
        conclusion: "failure",
        htmlUrl: "https://example.com/lint",
        outputTitle: "Lint",
        outputSummary: null,
        outputText: null,
      },
    ]);
    listLegacyCommitStatusesForHead.mockResolvedValueOnce([]);
    listFailingActionsJobsForHead.mockResolvedValueOnce({
      ok: true,
      jobs: [{ id: 1, name: "lint", conclusion: "failure" as const, htmlUrl: null }],
    });
    downloadActionsJobLogs.mockResolvedValueOnce({
      ok: true,
      text: "Format issues found in above 1 files.",
    });

    const summary = await buildCiSummary({
      headSha: "abc",
      waitMs: 0,
      author: mockAuthor,
    });

    expect(summary.status).toBe("failing");
    expect(summary.headline).toContain("lint");
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]?.reason).toContain("Format issues");
    expect(listFailingActionsJobsForHead).toHaveBeenCalled();
  });

  it("skips log fetch and LLM in lightweight mode", async () => {
    listCheckRunsForHead.mockResolvedValueOnce([
      {
        id: 11,
        name: "unit",
        status: "completed",
        conclusion: "failure",
        htmlUrl: null,
        outputTitle: null,
        outputSummary: "1 failed",
        outputText: null,
      },
    ]);
    listLegacyCommitStatusesForHead.mockResolvedValueOnce([]);

    const summary = await buildCiSummary({
      headSha: "abc",
      lightweight: true,
      waitMs: 0,
      author: mockAuthor,
    });

    expect(summary.status).toBe("failing");
    expect(summary.failures).toHaveLength(0);
    expect(listFailingActionsJobsForHead).not.toHaveBeenCalled();
  });

  it("lightweight mode still lists failing check names in headline", async () => {
    listCheckRunsForHead.mockResolvedValueOnce([
      {
        id: 1,
        name: "build",
        status: "completed",
        conclusion: "failure",
        htmlUrl: null,
        outputTitle: null,
        outputSummary: null,
        outputText: null,
      },
      {
        id: 2,
        name: "lint",
        status: "completed",
        conclusion: "failure",
        htmlUrl: null,
        outputTitle: null,
        outputSummary: null,
        outputText: null,
      },
    ]);
    listLegacyCommitStatusesForHead.mockResolvedValueOnce([]);

    const summary = await buildCiSummary({
      headSha: "abc",
      lightweight: true,
      waitMs: 0,
    });

    expect(summary.status).toBe("failing");
    expect(summary.headline).toContain("build");
    expect(summary.headline).toContain("lint");
    expect(summary.failures).toHaveLength(0);
  });

  it("uses facts-only failures when author is omitted", async () => {
    listCheckRunsForHead.mockResolvedValueOnce([
      {
        id: 1,
        name: "build",
        status: "completed",
        conclusion: "failure",
        htmlUrl: null,
        outputTitle: null,
        outputSummary: "build broke",
        outputText: null,
      },
    ]);
    listLegacyCommitStatusesForHead.mockResolvedValueOnce([]);

    const summary = await buildCiSummary({
      headSha: "abc",
      waitMs: 0,
    });

    expect(summary.status).toBe("failing");
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]?.reason).toContain("unavailable");
    expect(listFailingActionsJobsForHead).toHaveBeenCalled();
  });

  it("prefers condensed format failure over Node deprecation in author input", async () => {
    listCheckRunsForHead.mockResolvedValueOnce([
      {
        id: 11,
        name: "check",
        status: "completed",
        conclusion: "failure",
        htmlUrl: "https://example.com/check",
        outputTitle: null,
        outputSummary: null,
        outputText: "Format issues found",
      },
    ]);
    listLegacyCommitStatusesForHead.mockResolvedValueOnce([]);
    listFailingActionsJobsForHead.mockResolvedValueOnce({ ok: true, jobs: [] });

    const summary = await buildCiSummary({
      headSha: "abc",
      waitMs: 0,
      author: mockAuthor,
    });

    expect(summary.status).toBe("failing");
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]?.reason).toContain("Format issues");
    expect(summary.failures[0]?.reason).not.toContain("Node.js 20");
  });

  it("polls until CI transitions from pending to passing", async () => {
    listCheckRunsForHead
      .mockResolvedValueOnce([
        {
          id: 1,
          name: "ci",
          status: "in_progress",
          conclusion: null,
          htmlUrl: null,
          outputTitle: null,
          outputSummary: null,
          outputText: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 1,
          name: "ci",
          status: "completed",
          conclusion: "success",
          htmlUrl: null,
          outputTitle: null,
          outputSummary: null,
          outputText: null,
        },
      ]);
    listLegacyCommitStatusesForHead.mockResolvedValue([]);

    const summary = await buildCiSummary({
      headSha: "abc",
      waitMs: 500,
      waitPollMs: 50,
    });

    expect(summary.status).toBe("passing");
    expect(listCheckRunsForHead).toHaveBeenCalledTimes(2);
  });

  it("truncates failing headline after three check names", () => {
    const summary = summarizeCiSnapshot({
      checks: [
        {
          id: 1,
          name: "a",
          status: "completed",
          conclusion: "failure",
          htmlUrl: null,
          outputTitle: null,
          outputSummary: null,
          outputText: null,
        },
        {
          id: 2,
          name: "b",
          status: "completed",
          conclusion: "failure",
          htmlUrl: null,
          outputTitle: null,
          outputSummary: null,
          outputText: null,
        },
        {
          id: 3,
          name: "c",
          status: "completed",
          conclusion: "failure",
          htmlUrl: null,
          outputTitle: null,
          outputSummary: null,
          outputText: null,
        },
        {
          id: 4,
          name: "d",
          status: "completed",
          conclusion: "failure",
          htmlUrl: null,
          outputTitle: null,
          outputSummary: null,
          outputText: null,
        },
      ],
      statuses: [],
    });

    expect(summary.headline).toContain("a, b, c");
    expect(summary.headline).toContain("(+1 more)");
    expect(summary.headline).not.toContain("d");
  });

  it("asks to grant Checks Read when Checks permission is missing", async () => {
    listCheckRunsForHead.mockRejectedValueOnce(
      Object.assign(new Error("Not Found"), { status: 404 }),
    );
    isMissingChecksPermissionError.mockReturnValue(true);

    const summary = await buildCiSummary({
      headSha: "abc",
      waitMs: 0,
    });

    expect(summary.status).toBe("unavailable");
    expect(summary.headline).toMatch(/Checks to Read/i);
    expect(summary.headline).toMatch(/\/review/);
  });

  it("attaches an Actions Read grant note when job logs are blocked", async () => {
    listCheckRunsForHead.mockResolvedValueOnce([
      {
        id: 11,
        name: "lint",
        status: "completed",
        conclusion: "failure",
        htmlUrl: null,
        outputTitle: null,
        outputSummary: "Format issues found",
        outputText: null,
      },
    ]);
    listLegacyCommitStatusesForHead.mockResolvedValueOnce([]);
    listFailingActionsJobsForHead.mockResolvedValueOnce({
      ok: false,
      reason: "actions_permission",
    });

    const summary = await buildCiSummary({
      headSha: "abc",
      waitMs: 0,
      author: mockAuthor,
    });

    expect(summary.status).toBe("failing");
    expect(summary.permissionNote).toMatch(/Actions to Read/i);
    expect(summary.failures[0]?.reason).toContain("Format issues");
  });

  it("authors legacy commit status failures from facts + author", async () => {
    listCheckRunsForHead.mockResolvedValueOnce([]);
    listLegacyCommitStatusesForHead.mockResolvedValueOnce([
      {
        context: "ci/travis",
        state: "failure",
        description: "The Travis CI build failed",
        targetUrl: "https://travis.example/1",
      },
      {
        context: "pr-agent/review",
        state: "failure",
        description: "should be ignored",
        targetUrl: null,
      },
    ]);
    listFailingActionsJobsForHead.mockResolvedValueOnce({ ok: true, jobs: [] });

    const summary = await buildCiSummary({
      headSha: "abc",
      waitMs: 0,
      author: async () => ({
        headline: "❌ CI failing — ci/travis",
        failures: [
          {
            name: "ci/travis",
            reason: "The Travis CI build failed",
            fixHint: "Inspect Travis and re-push.",
          },
        ],
      }),
    });

    expect(summary.status).toBe("failing");
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]?.name).toBe("ci/travis");
    expect(summary.failures[0]?.reason).toContain("Travis");
  });
});
