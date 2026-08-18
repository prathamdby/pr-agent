import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ListPullRequestFilesResult } from "../src/github/listPullRequestFiles.js";

const HEAD_SHA = "h".repeat(40);

type ListedFile = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch: string;
};

const state = vi.hoisted(() => ({
  prepareCalls: 0,
  failNext: false,
  cleanup: vi.fn(async () => {}),
  pullsGetCalls: 0,
  listedFiles: [] as ListedFile[],
  changedFilesCount: 0,
  additions: 0,
  deletions: 0,
}));

vi.mock("../src/github/appAuth.js", () => ({
  installationOctokit: () => ({
    rest: {
      pulls: {
        get: async () => {
          state.pullsGetCalls += 1;
          return {
            data: {
              base: { sha: "b".repeat(40), ref: "main" },
              head: { sha: HEAD_SHA },
              additions: state.additions,
              deletions: state.deletions,
              changed_files: state.changedFilesCount,
            },
          };
        },
        listFiles: async () => ({ data: state.listedFiles }),
      },
    },
  }),
}));

vi.mock("../src/github/listPullRequestFiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/github/listPullRequestFiles.js")>();
  return {
    assertPullRequestFilesHeadSha: actual.assertPullRequestFilesHeadSha,
    fetchPullRequestFiles: (...args: Parameters<typeof actual.fetchPullRequestFiles>) =>
      actual.fetchPullRequestFiles(...args),
  };
});

vi.mock("../src/prWorkspace/localPrWorkspace.js", () => ({
  selectLocalPrWorkspaceCheckoutMode: (repositorySizeKb?: number) =>
    repositorySizeKb != null && repositorySizeKb > LOCAL_WORKSPACE_FULL_CLONE_MAX_REPO_KB
      ? "sparse"
      : "full",
  prepareLocalPrWorkspace: async (prepParams: {
    prFiles: ListPullRequestFilesResult;
    repositorySizeKb?: number;
  }) => {
    state.prepareCalls += 1;
    if (state.failNext) {
      state.failNext = false;
      throw new Error("clone failed");
    }
    const checkoutMode =
      prepParams.repositorySizeKb != null &&
      prepParams.repositorySizeKb > LOCAL_WORKSPACE_FULL_CLONE_MAX_REPO_KB
        ? "sparse"
        : "full";
    const changedFiles = prepParams.prFiles.files.map((file) => ({ path: file.filename }));
    const checkoutPaths = new Set(changedFiles.map((file) => file.path));
    return {
      agentCwd: "/tmp/x",
      cleanup: state.cleanup,
      changedFiles,
      stats: {
        truncated: prepParams.prFiles.truncated,
        fileCount: changedFiles.length,
        totalChanges: prepParams.prFiles.totalChanges,
        warning: prepParams.prFiles.warning,
      },
      checkoutMode,
      checkoutPaths,
      getCoverage: () => ({
        mode: checkoutMode,
        pathsInCheckout: checkoutPaths.size,
        changedFileCount: changedFiles.length,
        changeSetTruncated: prepParams.prFiles.truncated,
        ...(prepParams.prFiles.warning ? { warning: prepParams.prFiles.warning } : {}),
      }),
    };
  },
}));

import { withPrRepositoryView } from "../src/prWorkspace/prRepositoryView.js";
import * as listPullRequestFiles from "../src/github/listPullRequestFiles.js";
import {
  LOCAL_WORKSPACE_FULL_CLONE_MAX_REPO_KB,
  PR_REPOSITORY_VIEW_RELEASE_GRACE_MS,
} from "../src/settings/index.js";

const params = {
  owner: "o",
  repo: "r",
  prNumber: 1,
  headSha: HEAD_SHA,
  gitCredentialAuth: async () => ({ token: "t", expiresAtTs: Date.now() + 3_600_000 }),
};

function githubFile(filename: string): ListedFile {
  return {
    filename,
    status: "modified",
    additions: 1,
    deletions: 0,
    changes: 1,
    patch: `@@ ${filename}`,
  };
}

function setCanonicalGithubFiles(filenames: readonly string[]): void {
  state.listedFiles = filenames.map(githubFile);
  state.changedFilesCount = filenames.length;
  state.additions = filenames.length;
  state.deletions = 0;
}

function fileListResult(
  filenames: readonly string[],
  opts?: {
    truncated?: boolean;
    omittedCountLowerBound?: number;
    warning?: string;
    headSha?: string;
  },
): ListPullRequestFilesResult {
  return {
    files: filenames.map(githubFile),
    truncated: opts?.truncated ?? false,
    omittedCountLowerBound: opts?.omittedCountLowerBound ?? 0,
    totalChanges: filenames.length,
    headSha: opts?.headSha ?? HEAD_SHA,
    warning: opts?.warning,
  };
}

const completePaths = ["src/a.ts", "src/b.ts"] as const;
const truncatedPrFiles = fileListResult(["src/a.ts"], {
  truncated: true,
  omittedCountLowerBound: 1,
  warning: "Change set truncated to 1 files (1 omitted).",
});
const completePrFiles = fileListResult(completePaths);

function expectCompleteCoverage(view: {
  preflight: { files: readonly { filename: string }[]; truncated: boolean; fileCount: number };
  workspace: {
    getCoverage: () => {
      changeSetTruncated: boolean;
      changedFileCount: number;
      pathsInCheckout: number;
    };
  };
}): void {
  expect(view.preflight.truncated).toBe(false);
  expect(view.preflight.fileCount).toBe(2);
  expect(view.preflight.files.map((file) => file.filename)).toEqual([...completePaths]);
  const coverage = view.workspace.getCoverage();
  expect(coverage.changeSetTruncated).toBe(false);
  expect(coverage.changedFileCount).toBe(2);
  expect(coverage.pathsInCheckout).toBe(2);
}

describe("prRepositoryView cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setCanonicalGithubFiles(completePaths);
  });

  afterEach(async () => {
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    state.prepareCalls = 0;
    state.failNext = false;
    state.pullsGetCalls = 0;
    state.listedFiles = [];
    state.changedFilesCount = 0;
    state.additions = 0;
    state.deletions = 0;
    state.cleanup.mockClear();
  });

  it("shares one clone across concurrent holders and cleans up once", async () => {
    let openSecond!: () => void;
    const secondMayStart = new Promise<void>((r) => (openSecond = r));
    let finishFirst!: () => void;
    const firstHolds = new Promise<void>((r) => (finishFirst = r));

    const p1 = withPrRepositoryView(params, async () => {
      openSecond();
      await firstHolds;
      return 1;
    });
    const p2 = withPrRepositoryView(params, async () => 2);

    await secondMayStart;
    finishFirst();
    const [a, b] = await Promise.all([p1, p2]);

    expect(a).toBe(1);
    expect(b).toBe(2);
    expect(state.prepareCalls).toBe(1);
    expect(state.cleanup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(PR_REPOSITORY_VIEW_RELEASE_GRACE_MS);
    expect(state.cleanup).toHaveBeenCalledTimes(1);
  });

  it("reuses a released view during the grace period", async () => {
    await withPrRepositoryView(params, async () => "first");
    expect(state.prepareCalls).toBe(1);
    expect(state.cleanup).not.toHaveBeenCalled();

    await withPrRepositoryView(params, async () => "second");
    expect(state.prepareCalls).toBe(1);
    expect(state.cleanup).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(PR_REPOSITORY_VIEW_RELEASE_GRACE_MS);
    expect(state.cleanup).toHaveBeenCalledTimes(1);
  });

  it("issues exactly one pulls.get while preparing the repository view", async () => {
    await withPrRepositoryView(params, async () => "ok");
    expect(state.pullsGetCalls).toBe(1);
  });

  it("shares one fetchPullRequestFiles call across concurrent holders", async () => {
    const fetchSpy = vi.spyOn(listPullRequestFiles, "fetchPullRequestFiles");
    await Promise.all([
      withPrRepositoryView(params, async () => "a"),
      withPrRepositoryView(params, async () => "b"),
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("t");
    fetchSpy.mockRestore();
  });

  it("passes a resolved pull payload into file fetching", async () => {
    const fetchSpy = vi.spyOn(listPullRequestFiles, "fetchPullRequestFiles");
    const pullRequest = {
      additions: 0,
      deletions: 0,
      changed_files: 0,
      head: { sha: HEAD_SHA },
    };

    await withPrRepositoryView({ ...params, pullRequest }, async () => "ok");

    expect(fetchSpy.mock.calls[0]?.[5]).toBe(pullRequest);
    fetchSpy.mockRestore();
  });

  it("ignores a complete-looking supplied list and uses the canonical fetch", async () => {
    const fetchSpy = vi.spyOn(listPullRequestFiles, "fetchPullRequestFiles");
    const incompleteButUnflagged = fileListResult(["src/a.ts"]);

    await withPrRepositoryView({ ...params, prFiles: incompleteButUnflagged }, async (view) => {
      expectCompleteCoverage(view);
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(state.prepareCalls).toBe(1);
    fetchSpy.mockRestore();
  });

  it("does not let a truncated first list determine later complete coverage", async () => {
    const fetchSpy = vi.spyOn(listPullRequestFiles, "fetchPullRequestFiles");

    await withPrRepositoryView({ ...params, prFiles: truncatedPrFiles }, async (view) => {
      expectCompleteCoverage(view);
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(state.prepareCalls).toBe(1);

    await withPrRepositoryView({ ...params, prFiles: completePrFiles }, async (view) => {
      expectCompleteCoverage(view);
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(state.prepareCalls).toBe(1);

    fetchSpy.mockRestore();
  });

  it("still uses canonical coverage after the release grace window", async () => {
    await withPrRepositoryView({ ...params, prFiles: truncatedPrFiles }, async (view) => {
      expectCompleteCoverage(view);
    });
    await vi.advanceTimersByTimeAsync(PR_REPOSITORY_VIEW_RELEASE_GRACE_MS);
    expect(state.cleanup).toHaveBeenCalledTimes(1);
    state.prepareCalls = 0;

    await withPrRepositoryView({ ...params, prFiles: completePrFiles }, async (view) => {
      expectCompleteCoverage(view);
    });
    expect(state.prepareCalls).toBe(1);
  });

  it("gives concurrent truncated and complete callers the same complete coverage", async () => {
    const [truncatedView, completeView] = await Promise.all([
      withPrRepositoryView({ ...params, prFiles: truncatedPrFiles }, async (view) => view),
      withPrRepositoryView({ ...params, prFiles: completePrFiles }, async (view) => view),
    ]);

    expectCompleteCoverage(truncatedView);
    expectCompleteCoverage(completeView);
    expect(state.prepareCalls).toBe(1);
  });

  it("rejects a supplied file list whose head SHA does not match", async () => {
    await expect(
      withPrRepositoryView(
        {
          ...params,
          prFiles: fileListResult(["src/a.ts"], { headSha: "a".repeat(40) }),
        },
        async () => "ok",
      ),
    ).rejects.toMatchObject({ code: "github.head_sha_mismatch" });
    expect(state.prepareCalls).toBe(0);
  });

  it("rejects a fetched file list whose head SHA does not match", async () => {
    await expect(
      withPrRepositoryView({ ...params, headSha: "a".repeat(40) }, async () => "ok"),
    ).rejects.toMatchObject({ code: "github.head_sha_mismatch" });
    expect(state.prepareCalls).toBe(0);
  });

  it("does not share a full checkout with a sparse checkout of the same PR", async () => {
    await withPrRepositoryView(params, async (view) => {
      expect(view.workspace.checkoutMode).toBe("full");
      expectCompleteCoverage(view);
    });
    await withPrRepositoryView(
      { ...params, repositorySizeKb: LOCAL_WORKSPACE_FULL_CLONE_MAX_REPO_KB + 1 },
      async (view) => {
        expect(view.workspace.checkoutMode).toBe("sparse");
        expectCompleteCoverage(view);
      },
    );
    expect(state.prepareCalls).toBe(2);
  });

  it("re-prepares after a failed clone instead of caching the failure", async () => {
    state.failNext = true;
    await expect(withPrRepositoryView(params, async () => 1)).rejects.toThrow(/clone failed/);
    expect(state.prepareCalls).toBe(1);

    const result = await withPrRepositoryView(params, async () => "ok");
    expect(result).toBe("ok");
    expect(state.prepareCalls).toBe(2);
    expect(state.cleanup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(PR_REPOSITORY_VIEW_RELEASE_GRACE_MS);
    expect(state.cleanup).toHaveBeenCalledTimes(1);
  });
});
