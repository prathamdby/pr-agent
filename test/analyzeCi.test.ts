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
