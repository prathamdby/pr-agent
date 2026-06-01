import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  prepareCalls: 0,
  failNext: false,
  cleanup: vi.fn(async () => {}),
}));

vi.mock("../src/github/appAuth.js", () => ({
  installationOctokit: () => ({
    rest: {
      pulls: {
        get: async () => ({
          data: { base: { sha: "b".repeat(40), ref: "main" }, head: { sha: "h".repeat(40) } },
        }),
        listFiles: async () => ({ data: [] }),
      },
    },
  }),
}));

vi.mock("../src/github/listPullRequestFiles.js", () => ({
  fetchPullRequestFiles: async () => ({
    files: [],
    truncated: false,
    omittedCountLowerBound: 0,
    totalChanges: 0,
  }),
}));

vi.mock("../src/review/reviewPreflightFiles.js", () => ({
  buildReviewPreflightMetadataFromWorkspace: () => ({ preflight: true }),
}));

vi.mock("../src/prWorkspace/localPrWorkspace.js", () => ({
  prepareLocalPrWorkspace: async () => {
    state.prepareCalls += 1;
    if (state.failNext) {
      state.failNext = false;
      throw new Error("clone failed");
    }
    return { agentCwd: "/tmp/x", cleanup: state.cleanup };
  },
}));

import { withPrRepositoryView } from "../src/prWorkspace/prRepositoryView.js";

const params = {
  cfg: {} as never,
  owner: "o",
  repo: "r",
  prNumber: 1,
  headSha: "h".repeat(40),
  installationToken: "t",
};

describe("prRepositoryView cache", () => {
  afterEach(() => {
    state.prepareCalls = 0;
    state.failNext = false;
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
    expect(state.cleanup).toHaveBeenCalledTimes(1);
  });

  it("re-prepares after a failed clone instead of caching the failure", async () => {
    state.failNext = true;
    await expect(withPrRepositoryView(params, async () => 1)).rejects.toThrow(/clone failed/);
    expect(state.prepareCalls).toBe(1);

    const result = await withPrRepositoryView(params, async () => "ok");
    expect(result).toBe("ok");
    expect(state.prepareCalls).toBe(2);
    expect(state.cleanup).toHaveBeenCalledTimes(1);
  });
});
