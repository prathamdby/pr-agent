import { Octokit } from "@octokit/rest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isOwnCiCheck,
  summarizeCiFacts,
  summarizeCiSnapshot,
  applyCiCheckFact,
  classifySnapshot,
  hashCiFacts,
  parseCiAuthoredCache,
  ciSummaryFromFacts,
  WAITING_FOR_CI_SUMMARY,
  type CiCheckFact,
  type CiCheckRunSnapshot,
} from "../src/review/ci/ciFacts.ts";
import {
  CHECK_RUNS_PAGE_SIZE,
  REVIEW_CI_SUMMARY_GRANT_CHECKS,
  REVIEW_CI_SUMMARY_INCOMPLETE,
} from "../src/settings/index.ts";

const { installationOctokit } = vi.hoisted(() => ({
  installationOctokit: vi.fn(),
}));

vi.mock("../src/github/appAuth.ts", () => ({
  installationOctokit,
}));

function completedCheck(id: number, name: string, conclusion: string) {
  return ((pinnedReturn: CiCheckRunSnapshot) => pinnedReturn)({
    id,
    name,
    status: "completed",
    conclusion,
    htmlUrl: null,
  });
}

describe("summarizeCiSnapshot", () => {
  it("never reports passing or no CI when either source is denied or unlisted", () => {
    for (const checks of [[], [completedCheck(1, "lint", "success")]]) {
      for (const access of ["denied", "unknown", "available"] as const) {
        const summary = summarizeCiSnapshot({
          checks,
          statuses: [],
          sourceAvailability: {
            checks: { access: "available", listingRequired: false },
            statuses: { access, listingRequired: true },
          },
        });
        expect(summary.status).toBe("unavailable");
      }
    }
  });

  it("preserves known failures and exposes a partial view across missing sources", () => {
    const summary = summarizeCiSnapshot({
      checks: [completedCheck(1, "lint", "failure")],
      statuses: [],
      sourceAvailability: {
        checks: { access: "available", listingRequired: false },
        statuses: { access: "denied", listingRequired: true },
      },
    });
    expect(summary.status).toBe("failing");
    expect(summary.headline).toContain("partial CI view");
    expect(summary.permissionNote).toContain("statuses");
  });

  it("tells the operator to grant Checks only when check runs are denied", () => {
    const note = (checks: "denied" | "unknown" | "available", statuses: "denied" | "available") =>
      summarizeCiSnapshot({
        checks: [],
        statuses: [],
        sourceAvailability: {
          checks: { access: checks, listingRequired: checks !== "available" },
          statuses: { access: statuses, listingRequired: statuses !== "available" },
        },
      }).permissionNote;
    expect(note("denied", "available")).toBe(
      `Partial CI view: checks unavailable. ${REVIEW_CI_SUMMARY_GRANT_CHECKS}`,
    );
    expect(note("denied", "denied")).toBe(
      `Partial CI view: checks and statuses unavailable. ${REVIEW_CI_SUMMARY_GRANT_CHECKS}`,
    );
    expect(note("unknown", "available")).toBe("Partial CI view: checks unavailable.");
    expect(note("available", "denied")).toBe("Partial CI view: statuses unavailable.");
  });
  it("identifies the own check by App id or work-item external id", () => {
    const identity = { githubAppId: "99", workItemId: "wi-1" };
    expect(isOwnCiCheck(identity, { app_id: 99, external_id: null })).toBe(true);
    expect(isOwnCiCheck(identity, { app_id: 7, external_id: "wi-1" })).toBe(true);
    expect(isOwnCiCheck(identity, { app_id: 7, external_id: "other" })).toBe(false);
    expect(isOwnCiCheck({ githubAppId: "99" }, { app_id: 7, external_id: "wi-1" })).toBe(false);
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
        },
        {
          id: 2,
          name: "b",
          status: "completed",
          conclusion: "failure",
          htmlUrl: null,
        },
        {
          id: 3,
          name: "c",
          status: "completed",
          conclusion: "failure",
          htmlUrl: null,
        },
        {
          id: 4,
          name: "d",
          status: "completed",
          conclusion: "failure",
          htmlUrl: null,
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
});

describe("classifySnapshot and applyCiCheckFact", () => {
  function checkFact(
    name: string,
    status: string,
    conclusion: string | null,
    observedAt = "2026-01-01T00:00:00.000Z",
  ) {
    return ((pinnedReturn: CiCheckFact) => pinnedReturn)({
      name,
      source: "check_run",
      status,
      conclusion,
      url: null,
      external_id: null,
      app_id: null,
      check_run_id: 1,
      observed_at: observedAt,
    });
  }

  function statusFact(name: string, state: string, observedAt = "2026-01-01T00:00:00.000Z") {
    return ((pinnedReturn: CiCheckFact) => pinnedReturn)({
      name,
      source: "status",
      status: state,
      conclusion: null,
      url: null,
      external_id: null,
      app_id: null,
      check_run_id: null,
      observed_at: observedAt,
    });
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

  it("classifies a cancelled check as failing", () => {
    expect(classifySnapshot([checkFact("lint", "completed", "cancelled")])).toBe("failing");
  });

  it("summarizes stored facts as incomplete when the listing is truncated", () => {
    const summary = summarizeCiFacts(
      {
        lint: checkFact("lint", "completed", "success"),
      },
      { checkRunsComplete: false },
    );
    expect(summary.status).toBe("unavailable");
    expect(summary.headline).toBe(REVIEW_CI_SUMMARY_INCOMPLETE);
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

function factWith(overrides: Partial<CiCheckFact> = {}) {
  return ((pinnedReturn: CiCheckFact) => pinnedReturn)({
    name: "lint",
    source: "check_run",
    status: "completed",
    conclusion: "failure",
    url: "https://github.com/o/r/runs/1",
    external_id: null,
    app_id: 9,
    check_run_id: 77,
    observed_at: "2026-09-13T00:00:02.000Z",
    ...overrides,
  });
}

describe("head state rendering and authored cache", () => {
  it("hashes facts by name, source, status, and conclusion only", () => {
    const left = {
      lint: factWith(),
      unit: factWith({
        name: "unit",
        conclusion: "success",
        observed_at: "2026-09-13T00:00:01.000Z",
      }),
    };
    const right = {
      unit: factWith({
        name: "unit",
        conclusion: "success",
        url: "https://github.com/o/r/runs/99",
        observed_at: "2026-09-13T00:00:09.000Z",
      }),
      lint: factWith({
        url: "https://github.com/o/r/runs/2",
        observed_at: "2026-09-13T00:00:08.000Z",
      }),
    };
    expect(hashCiFacts(left)).toBe(hashCiFacts(right));
    expect(hashCiFacts(left)).not.toBe(hashCiFacts({ lint: factWith({ conclusion: "success" }) }));
  });

  it("rejects authored cache junk", () => {
    expect(parseCiAuthoredCache(null)).toBeNull();
    expect(parseCiAuthoredCache({})).toBeNull();
    expect(
      parseCiAuthoredCache({ factsHash: "", headline: "x", failures: [], authoredAt: "t" }),
    ).toBeNull();
    expect(
      parseCiAuthoredCache({
        factsHash: "abc",
        headline: "❌ CI failing — lint",
        failures: [{ name: "lint", reason: "fmt", fixHint: "oxfmt" }],
        authoredAt: "2026-09-13T00:00:00.000Z",
      }),
    ).toMatchObject({ factsHash: "abc", headline: "❌ CI failing — lint" });
  });

  it("renders authored cache only when the failing facts hash matches", () => {
    const failing = { lint: factWith() };
    const cache = {
      factsHash: hashCiFacts(failing),
      headline: "❌ authored lint",
      failures: [{ name: "lint", reason: "oxfmt failed", fixHint: "run oxfmt" }],
      authoredAt: "2026-09-13T00:00:00.000Z",
    };
    const hit = ciSummaryFromFacts(failing, 4, cache);
    expect(hit.version).toBe(4);
    expect(hit.summary.status).toBe("failing");
    expect(hit.summary.headline).toBe("❌ authored lint");
    expect(hit.summary.failures[0]?.reason).toBe("oxfmt failed");

    const stale = ciSummaryFromFacts(failing, 4, { ...cache, factsHash: "other" });
    expect(stale.summary.headline).toContain("CI failing");
    expect(stale.summary.headline).not.toBe("❌ authored lint");

    const passing = { lint: factWith({ conclusion: "success" }) };
    const passingCache = {
      factsHash: hashCiFacts(passing),
      headline: "❌ authored lint",
      failures: cache.failures,
      authoredAt: cache.authoredAt,
    };
    const ignored = ciSummaryFromFacts(passing, 2, passingCache);
    expect(ignored.summary.status).toBe("passing");
    expect(ignored.summary.headline).toContain("All CI is passing");

    expect(ciSummaryFromFacts({}, 0).summary).toEqual({
      status: "none",
      headline: "No CI checks on this head",
      failures: [],
    });
  });

  it("keeps incomplete empty listings unavailable while complete empty is none", () => {
    expect(ciSummaryFromFacts({}, 1).summary.status).toBe("none");
    expect(ciSummaryFromFacts({}, 1).summary.headline).toBe("No CI checks on this head");
    expect(WAITING_FOR_CI_SUMMARY.status).toBe("pending");
  });

  it("renders an incomplete listing as unavailable instead of waiting or passing", () => {
    const incompleteEmpty = ciSummaryFromFacts({}, 3, undefined, { checkRunsComplete: false });
    expect(incompleteEmpty.summary.status).toBe("unavailable");
    expect(incompleteEmpty.summary.headline).toBe(REVIEW_CI_SUMMARY_INCOMPLETE);

    const passing = { lint: factWith({ conclusion: "success" }) };
    const incompletePassing = ciSummaryFromFacts(passing, 3, undefined, {
      checkRunsComplete: false,
    });
    expect(incompletePassing.summary.status).toBe("unavailable");
    expect(incompletePassing.summary.headline).toBe(REVIEW_CI_SUMMARY_INCOMPLETE);
  });
});

type GithubCommitStatus = {
  readonly id: number;
  readonly node_id: string;
  readonly context: string;
  readonly state: string;
  readonly description: string | null;
  readonly target_url: string | null;
  readonly avatar_url: null;
  readonly url: string;
  readonly created_at: string;
  readonly updated_at: string;
};

function githubCommitStatus(context: string, id: number) {
  return {
    id,
    node_id: `status-${id}`,
    context,
    state: "success",
    description: "ok",
    target_url: `https://example.test/${context}`,
    avatar_url: null,
    url: `https://api.github.com/repos/acme/app/statuses/${id}`,
    created_at: "2026-11-23T00:00:00Z",
    updated_at: "2026-11-23T00:01:00Z",
  } satisfies GithubCommitStatus;
}

function combinedStatus(statuses: readonly GithubCommitStatus[], totalCount: number) {
  return {
    url: "https://api.github.com/repos/acme/app/commits/abc/status",
    state: statuses.length === 0 ? "pending" : "success",
    sha: "abc",
    total_count: totalCount,
    statuses,
    repository: { id: 1 },
    commit_url: "https://api.github.com/repos/acme/app/commits/abc",
  };
}

function octokitFor(pages: readonly (readonly GithubCommitStatus[])[]) {
  const octokit = new Octokit({ auth: "test" });
  let index = 0;
  const totalCount = pages.reduce((count, page) => count + page.length, 0);
  octokit.hook.wrap("request", async (_request, options) => {
    const url = options.url;
    if (url.includes("/check-runs")) {
      return {
        status: 200,
        url,
        headers: { link: "" },
        data: {
          total_count: 1,
          check_runs: [
            {
              id: 7,
              name: "build",
              node_id: "check-7",
              head_sha: "abc",
              status: "completed",
              conclusion: "success",
              html_url: "https://example.test/check",
              details_url: "https://example.test/check",
              started_at: "2026-11-23T00:00:00Z",
              completed_at: "2026-11-23T00:01:00Z",
              app: { id: 1 },
            },
          ],
        },
      };
    }
    const page = pages[index] ?? [];
    const next = index + 1 < pages.length;
    index += 1;
    return {
      status: 200,
      url,
      headers: {
        link: next
          ? `<https://api.github.com/repos/acme/app/commits/abc/status?page=${index + 1}>; rel="next"`
          : "",
      },
      data: combinedStatus(page, totalCount),
    };
  });
  return octokit;
}

async function readCombinedStatusSources(pages: readonly (readonly GithubCommitStatus[])[]) {
  installationOctokit.mockReturnValue(octokitFor(pages));
  const { readCiStatusSources } = await vi.importActual<typeof import("../src/github/ciStatus.ts")>(
    "../src/github/ciStatus.ts",
  );
  return readCiStatusSources({
    token: "tok",
    owner: "acme",
    repo: "app",
    headSha: "abc",
  });
}

describe("readCiStatusSources combined status", () => {
  beforeEach(() => {
    installationOctokit.mockReset();
  });

  it("reads statuses from the combined status object Octokit does not normalize", async () => {
    const result = await readCombinedStatusSources([[githubCommitStatus("ci/example", 1)]]);
    expect(result.sources.statuses).toEqual({ access: "available", complete: true });
    expect(result.legacyStatusesComplete).toBe(true);
    expect(result.legacyStatuses).toEqual([
      {
        context: "ci/example",
        state: "success",
        description: "ok",
        targetUrl: "https://example.test/ci/example",
        updatedAt: "2026-11-23T00:01:00Z",
        createdAt: "2026-11-23T00:00:00Z",
      },
    ]);
    expect(result.checkRunsComplete).toBe(true);
    expect(result.checkRuns).toMatchObject([{ id: 7, name: "build", conclusion: "success" }]);
  });

  it("treats an empty combined status body as a complete listing", async () => {
    const result = await readCombinedStatusSources([[]]);
    expect(result.legacyStatuses).toEqual([]);
    expect(result.legacyStatusesComplete).toBe(true);
    expect(result.sources.statuses).toEqual({ access: "available", complete: true });
  });

  it("follows the combined status link header across pages", async () => {
    const first = Array.from({ length: CHECK_RUNS_PAGE_SIZE }, (_, index) =>
      githubCommitStatus(`ci/${index}`, index + 1),
    );
    const result = await readCombinedStatusSources([
      first,
      [githubCommitStatus("ci/tail", 10_000)],
    ]);
    expect(result.legacyStatuses).toHaveLength(CHECK_RUNS_PAGE_SIZE + 1);
    expect(result.legacyStatuses.at(-1)?.context).toBe("ci/tail");
    expect(result.legacyStatusesComplete).toBe(true);
    expect(result.sources.statuses.access).toBe("available");
  });
});
