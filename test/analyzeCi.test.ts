import { describe, expect, it } from "vitest";
import {
  isOwnCiCheck,
  isOwnCommitStatusContext,
  summarizeCiFacts,
  summarizeCiSnapshot,
} from "../src/review/ci/analyzeCi.js";
import {
  applyCiCheckFact,
  classifySnapshot,
  type CiCheckFact,
} from "../src/review/ci/classifySnapshot.js";
import type { CiCheckRunSnapshot } from "../src/review/ci/ciSummaryTypes.js";
import { fetchCiAuthorContext } from "../src/review/ci/fetchCiAuthorContext.js";
import { createFakePrSurface } from "../src/github/prSurface.js";
import { REVIEW_CI_SUMMARY_INCOMPLETE } from "../src/settings/index.js";

function completedCheck(id: number, name: string, conclusion: string): CiCheckRunSnapshot {
  return {
    id,
    name,
    status: "completed",
    conclusion,
    htmlUrl: null,
    outputTitle: null,
    outputSummary: null,
    outputText: null,
  };
}

describe("analyzeCi", () => {
  it("identifies the own check by App id or work-item external id", () => {
    const identity = { githubAppId: "99", workItemId: "wi-1" };
    expect(isOwnCiCheck(identity, { app_id: 99, external_id: null })).toBe(true);
    expect(isOwnCiCheck(identity, { app_id: 7, external_id: "wi-1" })).toBe(true);
    expect(isOwnCiCheck(identity, { app_id: 7, external_id: "other" })).toBe(false);
    expect(isOwnCiCheck({ githubAppId: "99" }, { app_id: 7, external_id: "wi-1" })).toBe(false);
  });

  it("recognizes the own commit status context", () => {
    expect(isOwnCommitStatusContext("pr-agent/review")).toBe(true);
    expect(isOwnCommitStatusContext("Vercel")).toBe(false);
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

  it("does not treat an incomplete all-success snapshot as passing", () => {
    const checks = Array.from({ length: 500 }, (_, index) =>
      completedCheck(index + 1, `check-${index + 1}`, "success"),
    );
    const summary = summarizeCiSnapshot({
      checks,
      statuses: [],
      checkRunsComplete: false,
    });
    expect(summary.status).toBe("unavailable");
    expect(summary.headline).toBe(REVIEW_CI_SUMMARY_INCOMPLETE);
    expect(summary.headline).not.toMatch(/All CI is passing/i);
    expect(summary.headline).not.toMatch(/Checks to Read/i);
  });

  it("does not treat an incomplete empty snapshot as no CI", () => {
    const summary = summarizeCiSnapshot({
      checks: [],
      statuses: [],
      checkRunsComplete: false,
    });
    expect(summary.status).toBe("unavailable");
    expect(summary.headline).toBe(REVIEW_CI_SUMMARY_INCOMPLETE);
    expect(summary.status).not.toBe("none");
  });

  it("keeps known failures visible on an incomplete snapshot", () => {
    const summary = summarizeCiSnapshot({
      checks: [completedCheck(1, "lint", "failure")],
      statuses: [],
      checkRunsComplete: false,
    });
    expect(summary.status).toBe("failing");
    expect(summary.headline).toContain("lint");
    expect(summary.headline).toContain("partial CI view");
  });

  it("treats omitted completeness as a complete view", () => {
    const summary = summarizeCiSnapshot({
      checks: [completedCheck(1, "lint", "success")],
      statuses: [],
    });
    expect(summary.status).toBe("passing");
    expect(summary.headline).toContain("All CI is passing");
  });

  it("summarizes stored facts without a GitHub snapshot", () => {
    const summary = summarizeCiFacts({
      lint: {
        name: "lint",
        source: "check_run",
        status: "completed",
        conclusion: "failure",
        url: "https://github.com/o/r/actions/runs/1",
        external_id: null,
        app_id: 1,
        check_run_id: 11,
        observed_at: "2026-01-01T00:00:00.000Z",
      },
      Vercel: {
        name: "Vercel",
        source: "status",
        status: "success",
        conclusion: null,
        url: null,
        external_id: null,
        app_id: null,
        check_run_id: null,
        observed_at: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(summary.status).toBe("failing");
    expect(summary.headline).toContain("lint");
  });

  it("downloads Actions logs by check_run_id before listing workflow jobs", async () => {
    const fake = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
    fake.controls.setJobLogs(
      11,
      ["Format issues found in above 1 files.", "Error: Process completed with exit code 1."].join(
        "\n",
      ),
    );
    fake.controls.setFailingJobs("abc", [{ id: 99, name: "other", conclusion: "failure" }]);
    const context = await fetchCiAuthorContext({
      prSurface: fake.surface,
      headSha: "abc",
      checks: {
        lint: {
          name: "lint",
          source: "check_run",
          status: "completed",
          conclusion: "failure",
          url: "https://github.com/o/r/actions/runs/1",
          external_id: null,
          app_id: 1,
          check_run_id: 11,
          observed_at: "2026-01-01T00:00:00.000Z",
        },
      },
    });
    expect(context.condensedLogs).toContain("Format issues found");
    expect(fake.controls.events.filter((event) => event.kind === "downloadActionsJobLogs")).toEqual(
      [{ kind: "downloadActionsJobLogs", jobId: 11 }],
    );
    expect(fake.controls.events.some((event) => event.kind === "listFailingActionsJobs")).toBe(
      false,
    );
  });

  it("lists failing Actions jobs when check_run_id logs are empty", async () => {
    const fake = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
    fake.controls.setFailingJobs("abc", [
      {
        id: 99,
        name: "lint",
        conclusion: "failure",
        htmlUrl: "https://github.com/o/r/actions/runs/99",
      },
    ]);
    fake.controls.setJobLogs(
      99,
      ["Format issues found in above 1 files.", "Error: Process completed with exit code 1."].join(
        "\n",
      ),
    );
    const context = await fetchCiAuthorContext({
      prSurface: fake.surface,
      headSha: "abc",
      checks: {
        lint: {
          name: "lint",
          source: "check_run",
          status: "completed",
          conclusion: "failure",
          url: "https://github.com/o/r/actions/runs/1",
          external_id: null,
          app_id: 1,
          check_run_id: 11,
          observed_at: "2026-01-01T00:00:00.000Z",
        },
      },
    });
    expect(context.condensedLogs).toContain("Format issues found");
    expect(
      fake.controls.events
        .filter((event) => event.kind === "downloadActionsJobLogs")
        .map((event) => (event.kind === "downloadActionsJobLogs" ? event.jobId : null)),
    ).toEqual([11, 99]);
    expect(fake.controls.events.some((event) => event.kind === "listFailingActionsJobs")).toBe(
      true,
    );
  });
});

describe("classifySnapshot and applyCiCheckFact", () => {
  function checkFact(
    name: string,
    status: string,
    conclusion: string | null,
    observedAt = "2026-01-01T00:00:00.000Z",
  ): CiCheckFact {
    return {
      name,
      source: "check_run",
      status,
      conclusion,
      url: null,
      external_id: null,
      app_id: null,
      check_run_id: 1,
      observed_at: observedAt,
    };
  }

  function statusFact(
    name: string,
    state: string,
    observedAt = "2026-01-01T00:00:00.000Z",
  ): CiCheckFact {
    return {
      name,
      source: "status",
      status: state,
      conclusion: null,
      url: null,
      external_id: null,
      app_id: null,
      check_run_id: null,
      observed_at: observedAt,
    };
  }

  it("classifies empty facts as none", () => {
    expect(classifySnapshot([])).toBe("none");
  });

  it("lets a failing check beat a pending sibling", () => {
    expect(
      classifySnapshot([
        checkFact("lint", "completed", "failure"),
        checkFact("tests", "in_progress", null),
      ]),
    ).toBe("failing");
  });

  it("classifies a pending check as pending", () => {
    expect(classifySnapshot([checkFact("lint", "queued", null)])).toBe("pending");
  });

  it("classifies completed success as passing", () => {
    expect(classifySnapshot([checkFact("lint", "completed", "success")])).toBe("passing");
  });

  it("treats a legacy error status as failing", () => {
    expect(classifySnapshot([statusFact("Vercel", "error")])).toBe("failing");
  });

  it("rejects an older observation for the same name", () => {
    const current = {
      lint: checkFact("lint", "completed", "failure", "2026-01-01T00:00:02.000Z"),
    };
    const result = applyCiCheckFact(
      current,
      checkFact("lint", "completed", "success", "2026-01-01T00:00:01.000Z"),
      200,
    );
    expect(result.accepted).toBe(false);
    expect(result.checks.lint?.conclusion).toBe("failure");
  });

  it("accepts a newer observation and evicts the oldest other name on overflow", () => {
    const current = {
      old: checkFact("old", "completed", "success", "2026-01-01T00:00:01.000Z"),
      mid: checkFact("mid", "completed", "success", "2026-01-01T00:00:02.000Z"),
    };
    const incoming = checkFact("new", "completed", "failure", "2026-01-01T00:00:03.000Z");
    const result = applyCiCheckFact(current, incoming, 2);
    expect(result.accepted).toBe(true);
    expect(result.truncated).toBe(true);
    expect(Object.keys(result.checks).toSorted()).toEqual(["mid", "new"]);
  });
});
