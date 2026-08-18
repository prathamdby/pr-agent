import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ListFailingActionsJobsResult } from "../src/github/actionsLogs.js";

vi.mock("../src/github/ciStatus.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/github/ciStatus.js")>();
  return actual;
});

import {
  buildCiSummaryForSurface,
  isOwnCiCheckName,
  summarizeCiSnapshot,
} from "../src/review/ci/analyzeCi.js";
import { createFakePrSurface, type FakePrSurfaceControls } from "../src/github/prSurface.js";
import type { CiAuthorInput, CiSummaryAuthor } from "../src/review/ci/authorCiSummary.js";
import {
  REVIEW_CI_SUMMARY_LOG_MAX_BYTES,
  REVIEW_CI_SUMMARY_LOG_PER_JOB_MAX_CHARS,
} from "../src/settings/index.js";

function ciSurface() {
  return createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 }, { credentialToken: "t" });
}

async function buildCiSummary(
  options: Parameters<typeof buildCiSummaryForSurface>[1] & { headSha: string },
  setup?: (controls: FakePrSurfaceControls) => void,
) {
  const { surface, controls } = ciSurface();
  setup?.(controls);
  return buildCiSummaryForSurface(surface, options);
}

function expectSingleContext(input: CiAuthorInput): void {
  expect(input).not.toHaveProperty("checkOutputFallback");
  expect(typeof input.condensedLogs).toBe("string");
}

const mockAuthor: CiSummaryAuthor = async (input) => {
  expectSingleContext(input);
  return {
    headline: `❌ CI failing — ${input.failingNames.join(", ")}`,
    failures: input.failingNames.map((name) => ({
      name,
      reason: input.condensedLogs.includes("Format issues")
        ? "Format issues found; run oxfmt to fix."
        : input.condensedLogs.slice(0, 120) || "Check failed.",
      fixHint: "Fix the reported failure locally, then re-push.",
    })),
  };
};

describe("analyzeCi", () => {
  beforeEach(() => {
    // per-test setup via buildCiSummary helper
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
    const summary = await buildCiSummary(
      {
        headSha: "abc",
        waitMs: 0,
        author: mockAuthor,
      },
      (controls) => {
        controls.setCiStatus("abc", {
          checkRuns: [
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
          ],
          legacyStatuses: [],
        });
        controls.setFailingJobs("abc", [
          { id: 1, name: "lint", conclusion: "failure", htmlUrl: null },
        ]);
        controls.setJobLogs(1, "Format issues found in above 1 files.");
      },
    );

    expect(summary.status).toBe("failing");
    expect(summary.headline).toContain("lint");
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]?.reason).toContain("Format issues");
  });

  it("skips log fetch and LLM in lightweight mode", async () => {
    const { surface, controls } = ciSurface();
    controls.setCiStatus("abc", {
      checkRuns: [
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
      ],
      legacyStatuses: [],
    });

    const summary = await buildCiSummaryForSurface(surface, {
      headSha: "abc",
      lightweight: true,
      waitMs: 0,
      author: mockAuthor,
    });

    expect(summary.status).toBe("failing");
    expect(summary.failures).toHaveLength(0);
    expect(controls.events.filter((e) => e.kind === "listFailingActionsJobs")).toHaveLength(0);
  });

  it("lightweight mode still lists failing check names in headline", async () => {
    const summary = await buildCiSummary(
      {
        headSha: "abc",
        lightweight: true,
        waitMs: 0,
      },
      (controls) => {
        controls.setCiStatus("abc", {
          checkRuns: [
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
          ],
          legacyStatuses: [],
        });
      },
    );

    expect(summary.status).toBe("failing");
    expect(summary.headline).toContain("build");
    expect(summary.headline).toContain("lint");
    expect(summary.failures).toHaveLength(0);
  });

  it("uses facts-only failures when author is omitted", async () => {
    const { surface, controls } = ciSurface();
    controls.setCiStatus("abc", {
      checkRuns: [
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
      ],
      legacyStatuses: [],
    });

    const summary = await buildCiSummaryForSurface(surface, {
      headSha: "abc",
      waitMs: 0,
    });

    expect(summary.status).toBe("failing");
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]?.reason).toContain("unavailable");
    expect(controls.events.some((e) => e.kind === "listFailingActionsJobs")).toBe(true);
  });

  it("prefers condensed format failure over Node deprecation in author input", async () => {
    const summary = await buildCiSummary(
      {
        headSha: "abc",
        waitMs: 0,
        author: mockAuthor,
      },
      (controls) => {
        controls.setCiStatus("abc", {
          checkRuns: [
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
          ],
          legacyStatuses: [],
        });
      },
    );

    expect(summary.status).toBe("failing");
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]?.reason).toContain("Format issues");
    expect(summary.failures[0]?.reason).not.toContain("Node.js 20");
  });

  it("polls until CI transitions from pending to passing", async () => {
    const { surface, controls } = ciSurface();
    let poll = 0;
    const pendingRun = {
      id: 1,
      name: "ci",
      status: "in_progress" as const,
      conclusion: null,
      htmlUrl: null,
      outputTitle: null,
      outputSummary: null,
      outputText: null,
    };
    const passingRun = {
      ...pendingRun,
      status: "completed" as const,
      conclusion: "success" as const,
    };
    const originalGetCiStatus = surface.getCiStatus.bind(surface);
    vi.spyOn(surface, "getCiStatus").mockImplementation(async (headSha) => {
      poll += 1;
      const checkRuns = poll === 1 ? [pendingRun] : [passingRun];
      controls.setCiStatus(headSha, { checkRuns, legacyStatuses: [] });
      return originalGetCiStatus(headSha);
    });

    const summary = await buildCiSummaryForSurface(surface, {
      headSha: "abc",
      waitMs: 500,
      waitPollMs: 50,
    });

    expect(summary.status).toBe("passing");
    expect(poll).toBeGreaterThanOrEqual(2);
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

  it("propagates permission errors from fake getCiStatus", async () => {
    const { surface, controls } = ciSurface();
    const err = Object.assign(new Error("Resource not accessible by integration"), {
      status: 403,
    });
    controls.setCiStatusError(err);
    await expect(surface.getCiStatus("abc")).rejects.toBe(err);
  });

  it("asks to grant Checks Read when Checks permission is missing", async () => {
    const summary = await buildCiSummary(
      {
        headSha: "abc",
        waitMs: 0,
      },
      (controls) => {
        controls.setCiStatusError(
          Object.assign(new Error("Resource not accessible by integration"), { status: 403 }),
        );
      },
    );

    expect(summary.status).toBe("unavailable");
    expect(summary.headline).toMatch(/Checks to Read/i);
    expect(summary.headline).toMatch(/\/review/);
  });

  it("attaches an Actions Read grant note when job logs are blocked", async () => {
    const { surface, controls } = ciSurface();
    controls.setCiStatus("abc", {
      checkRuns: [
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
      ],
      legacyStatuses: [],
    });
    const originalListJobs = surface.listFailingActionsJobs.bind(surface);
    vi.spyOn(surface, "listFailingActionsJobs").mockImplementation(async (_headSha) => {
      const result: ListFailingActionsJobsResult = { ok: false, reason: "actions_permission" };
      return result;
    });

    const summary = await buildCiSummaryForSurface(surface, {
      headSha: "abc",
      waitMs: 0,
      author: mockAuthor,
    });

    expect(summary.status).toBe("failing");
    expect(summary.permissionNote).toMatch(/Actions to Read/i);
    expect(summary.failures[0]?.reason).toContain("Format issues");
    void originalListJobs;
  });

  it("authors legacy commit status failures from facts + author", async () => {
    const summary = await buildCiSummary(
      {
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
      },
      (controls) => {
        controls.setCiStatus("abc", {
          checkRuns: [],
          legacyStatuses: [
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
          ],
        });
      },
    );

    expect(summary.status).toBe("failing");
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]?.name).toBe("ci/travis");
    expect(summary.failures[0]?.reason).toContain("Travis");
  });

  it("falls back to condensed check output when job log download fails", async () => {
    let captured: CiAuthorInput | undefined;
    const summary = await buildCiSummary(
      {
        headSha: "abc",
        waitMs: 0,
        author: async (input) => {
          captured = input;
          expectSingleContext(input);
          return mockAuthor(input);
        },
      },
      (controls) => {
        controls.setCiStatus("abc", {
          checkRuns: [
            {
              id: 11,
              name: "lint",
              status: "completed",
              conclusion: "failure",
              htmlUrl: "https://example.com/lint",
              outputTitle: null,
              outputSummary: "Format issues found",
              outputText: null,
            },
          ],
          legacyStatuses: [],
        });
        controls.setFailingJobs("abc", [
          { id: 99, name: "lint", conclusion: "failure", htmlUrl: null },
        ]);
      },
    );

    expect(summary.status).toBe("failing");
    expect(captured?.condensedLogs).toContain("Format issues found");
    expect(summary.failures[0]?.reason).toContain("Format issues");
  });

  it("passes empty condensed context when no logs or check output exist", async () => {
    let captured: CiAuthorInput | undefined;
    const summary = await buildCiSummary(
      {
        headSha: "abc",
        waitMs: 0,
        author: async (input) => {
          captured = input;
          expectSingleContext(input);
          return mockAuthor(input);
        },
      },
      (controls) => {
        controls.setCiStatus("abc", {
          checkRuns: [
            {
              id: 11,
              name: "lint",
              status: "completed",
              conclusion: "failure",
              htmlUrl: null,
              outputTitle: null,
              outputSummary: null,
              outputText: null,
            },
          ],
          legacyStatuses: [],
        });
      },
    );

    expect(summary.status).toBe("failing");
    expect(captured?.condensedLogs).toBe("");
    expect(summary.failures[0]?.reason).toBe("Check failed.");
  });

  it("redacts secrets before the author sees condensed context", async () => {
    const token = "ghp_1234567890123456789012345678901234";
    let captured: CiAuthorInput | undefined;
    await buildCiSummary(
      {
        headSha: "abc",
        waitMs: 0,
        author: async (input) => {
          captured = input;
          return mockAuthor(input);
        },
      },
      (controls) => {
        controls.setCiStatus("abc", {
          checkRuns: [
            {
              id: 11,
              name: "lint",
              status: "completed",
              conclusion: "failure",
              htmlUrl: null,
              outputTitle: null,
              outputSummary: null,
              outputText: null,
            },
          ],
          legacyStatuses: [],
        });
        controls.setFailingJobs("abc", [
          { id: 1, name: "lint", conclusion: "failure", htmlUrl: null },
        ]);
        controls.setJobLogs(
          1,
          `Error: Process completed with exit code 1.\nAuthorization: Bearer ${token}`,
        );
      },
    );

    expect(captured?.condensedLogs).not.toContain(token);
    expect(captured?.condensedLogs).toContain("[redacted]");
  });

  it("keeps author context under the global condensed-log byte budget", async () => {
    let captured: CiAuthorInput | undefined;
    const hugeError = `Error: Process completed with exit code 1.\n${"x".repeat(20_000)}`;
    await buildCiSummary(
      {
        headSha: "abc",
        waitMs: 0,
        author: async (input) => {
          captured = input;
          return mockAuthor(input);
        },
      },
      (controls) => {
        controls.setCiStatus("abc", {
          checkRuns: [
            {
              id: 11,
              name: "lint",
              status: "completed",
              conclusion: "failure",
              htmlUrl: null,
              outputTitle: null,
              outputSummary: null,
              outputText: null,
            },
            {
              id: 12,
              name: "test",
              status: "completed",
              conclusion: "failure",
              htmlUrl: null,
              outputTitle: null,
              outputSummary: null,
              outputText: null,
            },
            {
              id: 13,
              name: "build",
              status: "completed",
              conclusion: "failure",
              htmlUrl: null,
              outputTitle: null,
              outputSummary: null,
              outputText: null,
            },
          ],
          legacyStatuses: [],
        });
        controls.setFailingJobs("abc", [
          { id: 1, name: "lint", conclusion: "failure", htmlUrl: null },
          { id: 2, name: "test", conclusion: "failure", htmlUrl: null },
          { id: 3, name: "build", conclusion: "failure", htmlUrl: null },
        ]);
        controls.setJobLogs(1, hugeError);
        controls.setJobLogs(2, hugeError);
        controls.setJobLogs(3, hugeError);
      },
    );

    expect(captured).toBeDefined();
    expect(Buffer.byteLength(captured?.condensedLogs ?? "", "utf8")).toBeLessThanOrEqual(
      REVIEW_CI_SUMMARY_LOG_MAX_BYTES,
    );
    expect(captured?.condensedLogs.length).toBeGreaterThan(0);
  });

  it("bounds huge check output before it reaches the author", async () => {
    const token = "ghp_1234567890123456789012345678901234";
    let captured: CiAuthorInput | undefined;
    await buildCiSummary(
      {
        headSha: "abc",
        waitMs: 0,
        author: async (input) => {
          captured = input;
          expectSingleContext(input);
          return mockAuthor(input);
        },
      },
      (controls) => {
        controls.setCiStatus("abc", {
          checkRuns: [
            {
              id: 11,
              name: "lint",
              status: "completed",
              conclusion: "failure",
              htmlUrl: null,
              outputTitle: null,
              outputSummary: null,
              outputText: `Error: Process completed with exit code 1.\nAuthorization: Bearer ${token}\n${"z".repeat(50_000)}`,
            },
          ],
          legacyStatuses: [],
        });
      },
    );

    const context = captured?.condensedLogs ?? "";
    expect(context.length).toBeGreaterThan(0);
    expect(context.length).toBeLessThanOrEqual(REVIEW_CI_SUMMARY_LOG_PER_JOB_MAX_CHARS);
    expect(Buffer.byteLength(context, "utf8")).toBeLessThanOrEqual(REVIEW_CI_SUMMARY_LOG_MAX_BYTES);
    expect(context).not.toContain(token);
    expect(context.length).toBeLessThan(50_000);
  });

  it("uses facts-only failures when the LLM author returns null", async () => {
    const summary = await buildCiSummary(
      {
        headSha: "abc",
        waitMs: 0,
        author: async (input) => {
          expectSingleContext(input);
          return null;
        },
      },
      (controls) => {
        controls.setCiStatus("abc", {
          checkRuns: [
            {
              id: 1,
              name: "build",
              status: "completed",
              conclusion: "failure",
              htmlUrl: "https://example.com/build",
              outputTitle: null,
              outputSummary: "build broke",
              outputText: null,
            },
          ],
          legacyStatuses: [],
        });
      },
    );

    expect(summary.status).toBe("failing");
    expect(summary.headline).toContain("build");
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]?.reason).toContain("unavailable");
    expect(summary.failures[0]?.url).toBe("https://example.com/build");
  });
});
