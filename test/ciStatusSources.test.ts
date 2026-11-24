import { Octokit } from "@octokit/rest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHECK_RUNS_PAGE_SIZE } from "../src/settings/index.ts";

const { installationOctokit } = vi.hoisted(() => ({
  installationOctokit: vi.fn(),
}));

vi.mock("../src/github/appAuth.ts", () => ({
  installationOctokit,
}));

type CommitStatus = {
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

function commitStatus(context: string, id: number) {
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
  } satisfies CommitStatus;
}

function combinedStatus(statuses: readonly CommitStatus[], totalCount: number) {
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

function octokitFor(pages: readonly (readonly CommitStatus[])[]) {
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

async function readSources(pages: readonly (readonly CommitStatus[])[]) {
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
    const result = await readSources([[commitStatus("ci/example", 1)]]);
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
    const result = await readSources([[]]);
    expect(result.legacyStatuses).toEqual([]);
    expect(result.legacyStatusesComplete).toBe(true);
    expect(result.sources.statuses).toEqual({ access: "available", complete: true });
  });

  it("follows the combined status link header across pages", async () => {
    const first = Array.from({ length: CHECK_RUNS_PAGE_SIZE }, (_, index) =>
      commitStatus(`ci/${index}`, index + 1),
    );
    const result = await readSources([first, [commitStatus("ci/tail", 10_000)]]);
    expect(result.legacyStatuses).toHaveLength(CHECK_RUNS_PAGE_SIZE + 1);
    expect(result.legacyStatuses.at(-1)?.context).toBe("ci/tail");
    expect(result.legacyStatusesComplete).toBe(true);
    expect(result.sources.statuses.access).toBe("available");
  });
});
