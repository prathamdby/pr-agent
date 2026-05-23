import { describe, expect, it, vi } from "vitest";
import { TOKEN_FRESHNESS_BUFFER_MS } from "../src/settings/constants.js";
import { createRefreshableToolExecutors } from "../src/agent/cursor/refreshableGithubTools.js";

describe("createRefreshableToolExecutors", () => {
  it("refreshes token and rebuilds executors when near expiry", async () => {
    const refresh = vi.fn(async () => ({
      token: "fresh-token",
      expiresAtTs: Date.now() + 3_600_000,
    }));
    const build = vi.fn((token: string) => ({
      piTools: [],
      executors: {
        getPullRequest: vi.fn(async () => ({ tokenUsed: token })),
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
    expect(build).toHaveBeenCalledTimes(2);
    expect(build).toHaveBeenLastCalledWith("fresh-token");
  });
});
