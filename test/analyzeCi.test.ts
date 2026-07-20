import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  listCheckRunsForHead,
  listCheckRunAnnotations,
  listLegacyCommitStatusesForHead,
  isMissingChecksPermissionError,
} = vi.hoisted(() => ({
  listCheckRunsForHead: vi.fn(),
  listCheckRunAnnotations: vi.fn(),
  listLegacyCommitStatusesForHead: vi.fn(),
  isMissingChecksPermissionError: vi.fn((_error?: unknown) => false),
}));

vi.mock("../src/github/ciStatus.js", () => ({
  listCheckRunsForHead,
  listCheckRunAnnotations,
  listLegacyCommitStatusesForHead,
  isMissingChecksPermissionError,
}));

import {
  buildCiSummary,
  isOwnCiCheckName,
  summarizeCiSnapshot,
} from "../src/review/ci/analyzeCi.js";

describe("analyzeCi", () => {
  beforeEach(() => {
    listCheckRunsForHead.mockReset();
    listCheckRunAnnotations.mockReset();
    listLegacyCommitStatusesForHead.mockReset();
    isMissingChecksPermissionError.mockReset();
    isMissingChecksPermissionError.mockReturnValue(false);
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

  it("builds a failure digest from annotations", async () => {
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
    listCheckRunAnnotations.mockResolvedValueOnce([
      {
        path: "src/foo.ts",
        startLine: 12,
        endLine: 12,
        title: "Unexpected any",
        message: "Unexpected any. Specify a different type.",
        annotationLevel: "failure",
      },
    ]);

    const summary = await buildCiSummary({
      token: "t",
      owner: "o",
      repo: "r",
      headSha: "abc",
      waitMs: 0,
    });

    expect(summary.status).toBe("failing");
    expect(summary.headline).toContain("lint");
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]?.reason).toContain("src/foo.ts:12");
    expect(summary.failures[0]?.fixHint.toLowerCase()).toContain("lint");
    expect(listCheckRunAnnotations).toHaveBeenCalledWith("t", "o", "r", 11, undefined);
  });

  it("skips annotation digests in lightweight mode", async () => {
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
      token: "t",
      owner: "o",
      repo: "r",
      headSha: "abc",
      lightweight: true,
      waitMs: 0,
    });

    expect(summary.status).toBe("failing");
    expect(summary.failures).toHaveLength(0);
    expect(listCheckRunAnnotations).not.toHaveBeenCalled();
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
      token: "t",
      owner: "o",
      repo: "r",
      headSha: "abc",
      lightweight: true,
      waitMs: 0,
    });

    expect(summary.status).toBe("failing");
    expect(summary.headline).toContain("build");
    expect(summary.headline).toContain("lint");
    expect(summary.failures).toHaveLength(0);
  });

  it("caps total failures to maxFailures across checks and legacy statuses", async () => {
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
      {
        id: 2,
        name: "lint",
        status: "completed",
        conclusion: "failure",
        htmlUrl: null,
        outputTitle: null,
        outputSummary: "lint broke",
        outputText: null,
      },
    ]);
    listLegacyCommitStatusesForHead.mockResolvedValueOnce([
      {
        context: "ci/ext",
        state: "failure",
        description: "ext failed",
        targetUrl: null,
      },
    ]);
    listCheckRunAnnotations.mockResolvedValue([]);

    const summary = await buildCiSummary({
      token: "t",
      owner: "o",
      repo: "r",
      headSha: "abc",
      waitMs: 0,
      maxFailures: 1,
    });

    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]?.name).toBe("build");
  });

  it("digests check outputText when annotations are empty", async () => {
    listCheckRunsForHead.mockResolvedValueOnce([
      {
        id: 11,
        name: "unit",
        status: "completed",
        conclusion: "failure",
        htmlUrl: null,
        outputTitle: null,
        outputSummary: null,
        outputText: "Error: AssertionError: expected 2 to equal 1\n    at Object.<anonymous>",
      },
    ]);
    listLegacyCommitStatusesForHead.mockResolvedValueOnce([]);
    listCheckRunAnnotations.mockResolvedValueOnce([]);

    const summary = await buildCiSummary({
      token: "t",
      owner: "o",
      repo: "r",
      headSha: "abc",
      waitMs: 0,
    });

    expect(summary.status).toBe("failing");
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]?.reason).toContain("AssertionError");
  });

  it("prefers check output over runner warning annotations", async () => {
    listCheckRunsForHead.mockResolvedValueOnce([
      {
        id: 11,
        name: "check",
        status: "completed",
        conclusion: "failure",
        htmlUrl: "https://example.com/check",
        outputTitle: null,
        outputSummary: null,
        outputText:
          "Checking formatting...\n\nsrc/foo.ts (0ms)\n\nFormat issues found in above 1 files. Run without `--check` to fix.\nError: Process completed with exit code 1.",
      },
    ]);
    listLegacyCommitStatusesForHead.mockResolvedValueOnce([]);
    listCheckRunAnnotations.mockResolvedValueOnce([
      {
        path: ".github",
        startLine: 2,
        endLine: 2,
        title: null,
        message:
          "Node.js 20 is deprecated. The following actions target Node.js 20 but are being forced to run on Node.js 24: actions/cache@v4, actions/checkout@v4.",
        annotationLevel: "warning",
      },
    ]);

    const summary = await buildCiSummary({
      token: "t",
      owner: "o",
      repo: "r",
      headSha: "abc",
      waitMs: 0,
    });

    expect(summary.status).toBe("failing");
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]?.reason).toContain("Format issues found");
    expect(summary.failures[0]?.reason).not.toContain("Node.js 20");
    expect(summary.failures[0]?.fixHint.toLowerCase()).toMatch(/format|lint/);
  });

  it("ignores warning-only annotations when the check failed without output", async () => {
    listCheckRunsForHead.mockResolvedValueOnce([
      {
        id: 11,
        name: "check",
        status: "completed",
        conclusion: "failure",
        htmlUrl: null,
        outputTitle: null,
        outputSummary: null,
        outputText: null,
      },
    ]);
    listLegacyCommitStatusesForHead.mockResolvedValueOnce([]);
    listCheckRunAnnotations.mockResolvedValueOnce([
      {
        path: ".github",
        startLine: 2,
        endLine: 2,
        title: null,
        message: "Node.js 20 is deprecated.",
        annotationLevel: "warning",
      },
    ]);

    const summary = await buildCiSummary({
      token: "t",
      owner: "o",
      repo: "r",
      headSha: "abc",
      waitMs: 0,
    });

    expect(summary.status).toBe("failing");
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]?.reason).toContain("Check concluded failure");
    expect(summary.failures[0]?.reason).not.toContain("Node.js 20");
  });

  it("still uses failure-level annotations when present", async () => {
    listCheckRunsForHead.mockResolvedValueOnce([
      {
        id: 11,
        name: "lint",
        status: "completed",
        conclusion: "failure",
        htmlUrl: null,
        outputTitle: null,
        outputSummary: null,
        outputText: "Format issues found in above 1 files.",
      },
    ]);
    listLegacyCommitStatusesForHead.mockResolvedValueOnce([]);
    listCheckRunAnnotations.mockResolvedValueOnce([
      {
        path: "src/foo.ts",
        startLine: 12,
        endLine: 12,
        title: "Unexpected any",
        message: "Unexpected any. Specify a different type.",
        annotationLevel: "failure",
      },
      {
        path: ".github",
        startLine: 2,
        endLine: 2,
        title: null,
        message: "Node.js 20 is deprecated.",
        annotationLevel: "warning",
      },
    ]);

    const summary = await buildCiSummary({
      token: "t",
      owner: "o",
      repo: "r",
      headSha: "abc",
      waitMs: 0,
    });

    expect(summary.failures[0]?.reason).toContain("src/foo.ts:12");
    expect(summary.failures[0]?.reason).not.toContain("Format issues");
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
      token: "t",
      owner: "o",
      repo: "r",
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

  it("returns unavailable when Checks permission is missing", async () => {
    listCheckRunsForHead.mockRejectedValueOnce(
      Object.assign(new Error("Not Found"), { status: 404 }),
    );
    isMissingChecksPermissionError.mockReturnValue(true);

    const summary = await buildCiSummary({
      token: "t",
      owner: "o",
      repo: "r",
      headSha: "abc",
      waitMs: 0,
    });

    expect(summary.status).toBe("unavailable");
  });

  it("digests legacy commit status failures", async () => {
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

    const summary = await buildCiSummary({
      token: "t",
      owner: "o",
      repo: "r",
      headSha: "abc",
      waitMs: 0,
    });

    expect(summary.status).toBe("failing");
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]?.name).toBe("ci/travis");
    expect(summary.failures[0]?.reason).toContain("Travis");
  });
});
