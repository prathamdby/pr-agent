import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withPrRepositoryView } from "../src/prWorkspace/prRepositoryView.js";
import * as listPullRequestFiles from "../src/github/listPullRequestFiles.js";
import * as localPrWorkspace from "../src/prWorkspace/localPrWorkspace.js";
import * as reviewPreflightFiles from "../src/review/placement/reviewPreflightFiles.js";
import {
  resetInstallationOctokitFactory,
  setInstallationOctokitFactory,
  type InstallationOctokitClient,
} from "../src/github/appAuth.js";
import { PR_REPOSITORY_VIEW_RELEASE_GRACE_MS } from "../src/settings/index.js";
import { mockLocalPrWorkspace } from "./helpers/mockWorkspace.js";

const state = {
  prepareCalls: 0,
  failNext: false,
  cleanup: vi.fn(async () => {}),
  pullsGetCalls: 0,
};

function fakeOctokit(): InstallationOctokitClient {
  return {
    rest: {
      pulls: {
        get: vi.fn(async () => {
          state.pullsGetCalls += 1;
          return {
            data: {
              base: { sha: "b".repeat(40), ref: "main" },
              head: { sha: "h".repeat(40) },
              additions: 0,
              deletions: 0,
              changed_files: 0,
            },
          };
        }),
        listFiles: vi.fn(async () => ({ data: [] })),
      },
    },
    hook: { after: vi.fn() },
  };
}

const params = {
  owner: "o",
  repo: "r",
  prNumber: 1,
  headSha: "h".repeat(40),
  gitCredentialAuth: async () => ({ token: "t", expiresAtTs: Date.now() + 3_600_000 }),
};
const prFiles = {
  files: [],
  truncated: false,
  omittedCountLowerBound: 0,
  totalChanges: 0,
  headSha: "h".repeat(40),
};

describe("prRepositoryView cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setInstallationOctokitFactory(fakeOctokit);
    vi.spyOn(reviewPreflightFiles, "buildReviewPreflightMetadataFromWorkspace").mockReturnValue({
      files: [],
      truncated: false,
      fileCount: 0,
      totalChanges: 0,
    });
    vi.spyOn(localPrWorkspace, "prepareLocalPrWorkspace").mockImplementation(async () => {
      state.prepareCalls += 1;
      if (state.failNext) {
        state.failNext = false;
        throw new Error("clone failed");
      }
      return { ...mockLocalPrWorkspace("/tmp/x"), cleanup: state.cleanup };
    });
  });

  afterEach(async () => {
    resetInstallationOctokitFactory();
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    state.prepareCalls = 0;
    state.failNext = false;
    state.pullsGetCalls = 0;
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
      head: { sha: "h".repeat(40) },
    };

    await withPrRepositoryView({ ...params, pullRequest }, async () => "ok");

    expect(fetchSpy.mock.calls[0]?.[5]).toBe(pullRequest);
    fetchSpy.mockRestore();
  });

  it("uses prefetched pull request files when supplied", async () => {
    const fetchSpy = vi.spyOn(listPullRequestFiles, "fetchPullRequestFiles");

    await withPrRepositoryView({ ...params, prFiles }, async () => "ok");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(state.prepareCalls).toBe(1);
    fetchSpy.mockRestore();
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
