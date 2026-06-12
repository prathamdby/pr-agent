import { describe, expect, it, vi } from "vitest";
import { TOKEN_FRESHNESS_BUFFER_MS } from "../src/settings/constants.js";
import { buildGithubTools } from "../src/agent/githubTools.js";
import { createRefreshableToolExecutors } from "../src/agent/providers/cursor/refreshableGithubTools.js";

describe("createRefreshableToolExecutors", () => {
  it("refreshes token and rebuilds executors when near expiry", async () => {
    const freshExpiresAtTs = Date.now() + 3_600_000;
    const refresh = vi.fn(async () => ({
      token: "fresh-token",
      expiresAtTs: freshExpiresAtTs,
    }));
    const build = vi.fn((token: string, expiresAtTs: number) => ({
      piTools: [],
      executors: {
        getPullRequest: vi.fn(async () => ({ tokenUsed: token, expiresAtTs })),
      },
    }));

    const refreshable = createRefreshableToolExecutors({
      initialToken: "stale-token",
      tokenExpiresAtTs: Date.now() + TOKEN_FRESHNESS_BUFFER_MS - 1_000,
      refreshInstallationToken: refresh,
      build,
      githubToolNames: new Set(["getPullRequest"]),
    });

    await refreshable.refreshBeforeTool("getPullRequest");

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refreshable.getToken()).toBe("fresh-token");
    expect(refreshable.getTokenExpiresAtTs()).toBe(freshExpiresAtTs);
    expect(build).toHaveBeenCalledTimes(2);
    expect(build).toHaveBeenLastCalledWith("fresh-token", freshExpiresAtTs);
  });

  it("keeps static GitHub tool parameter schemas identical across token rebuilds", () => {
    const first = buildGithubTools("old-token");
    const second = buildGithubTools("new-token");

    for (let i = 0; i < first.piTools.length; i++) {
      expect(second.piTools[i]?.parameters).toBe(first.piTools[i]?.parameters);
    }
    expect(second.executors.getPullRequest).not.toBe(first.executors.getPullRequest);
  });
});
