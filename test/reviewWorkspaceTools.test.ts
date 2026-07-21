import { beforeEach, describe, expect, it, vi } from "vitest";
import { TOKEN_FRESHNESS_BUFFER_MS } from "../src/settings/index.js";
import { buildReviewWorkspaceTools } from "../src/review/run/reviewWorkspaceTools.js";
import { mockLocalPrWorkspace } from "./helpers/mockWorkspace.js";
import { makeTestConfig } from "./helpers/config.js";

const localMocks = vi.hoisted(() => ({
  builds: 0,
  tokensSeen: [] as string[],
  buildLocalWorkspaceTools: vi.fn((..._args: unknown[]) => {
    localMocks.builds += 1;
    const generation = localMocks.builds;
    return {
      piTools: [{ name: "getPullRequest", description: "d", parameters: { type: "object" } }],
      executors: {
        getPullRequest: vi.fn(async () => {
          localMocks.tokensSeen.push(`gen-${generation}`);
          return { generation };
        }),
      },
    };
  }),
}));

vi.mock("../src/agent/tools/localWorkspaceTools.js", () => ({
  buildLocalWorkspaceTools: (...args: unknown[]) => localMocks.buildLocalWorkspaceTools(...args),
}));

vi.mock("../src/agent/tools/context7Tools.js", () => ({
  buildContext7Tools: () => ({
    piTools: [],
    executors: {
      resolveLibraryId: vi.fn(async () => ({ ok: true })),
    },
  }),
}));

describe("buildReviewWorkspaceTools live token holder", () => {
  beforeEach(() => {
    localMocks.builds = 0;
    localMocks.tokensSeen = [];
    localMocks.buildLocalWorkspaceTools.mockClear();
  });

  it("updates getToken and getTokenExpiresAtTs after near-expiry refresh", async () => {
    const freshExpiresAtTs = Date.now() + 3_600_000;
    const refreshInstallationToken = vi.fn(async () => ({
      token: "fresh-live-token",
      expiresAtTs: freshExpiresAtTs,
    }));

    const tools = buildReviewWorkspaceTools({
      cfg: makeTestConfig(),
      token: "stale-token",
      tokenExpiresAtTs: Date.now() + TOKEN_FRESHNESS_BUFFER_MS - 1_000,
      tokenTtlMs: 3_600_000,
      workspace: mockLocalPrWorkspace(),
      refreshInstallationToken,
    });

    expect(tools.getToken()).toBe("stale-token");

    await tools.refreshNearExpiry();

    expect(refreshInstallationToken).toHaveBeenCalledTimes(1);
    expect(tools.getToken()).toBe("fresh-live-token");
    expect(tools.getTokenExpiresAtTs()).toBe(freshExpiresAtTs);
  });

  it("holder-updating refreshInstallationToken keeps getToken in sync", async () => {
    const freshExpiresAtTs = Date.now() + 7_200_000;
    const refreshInstallationToken = vi.fn(async () => ({
      token: "minted",
      expiresAtTs: freshExpiresAtTs,
    }));

    const tools = buildReviewWorkspaceTools({
      cfg: makeTestConfig(),
      token: "old",
      tokenExpiresAtTs: Date.now() + 60_000,
      tokenTtlMs: 3_600_000,
      workspace: mockLocalPrWorkspace(),
      refreshInstallationToken,
    });

    const fresh = await tools.refreshInstallationToken!();
    expect(fresh.token).toBe("minted");
    expect(tools.getToken()).toBe("minted");
    expect(tools.getTokenExpiresAtTs()).toBe(freshExpiresAtTs);
  });

  it("preserves the mutable refreshable executor store so post-refresh calls use the rebuilt executor", async () => {
    const freshExpiresAtTs = Date.now() + 3_600_000;
    const refreshInstallationToken = vi.fn(async () => ({
      token: "fresh-live-token",
      expiresAtTs: freshExpiresAtTs,
    }));

    const tools = buildReviewWorkspaceTools({
      cfg: makeTestConfig(),
      token: "stale-token",
      tokenExpiresAtTs: Date.now() + TOKEN_FRESHNESS_BUFFER_MS - 1_000,
      tokenTtlMs: 3_600_000,
      workspace: mockLocalPrWorkspace(),
      refreshInstallationToken,
    });

    const store = tools.executors;
    expect(store.resolveLibraryId).toBeTypeOf("function");

    const before = await store.getPullRequest!({});
    expect(before).toEqual({ generation: 1 });
    expect(tools.getToken()).toBe("stale-token");

    await tools.refreshNearExpiry();

    expect(tools.getToken()).toBe("fresh-live-token");
    const after = await store.getPullRequest!({});
    expect(after).toEqual({ generation: 2 });
    expect(localMocks.tokensSeen).toEqual(["gen-1", "gen-2"]);
    // Same object identity as the live refreshable store (not a spread snapshot).
    expect(await tools.executors.getPullRequest!({})).toEqual({ generation: 2 });
    expect(tools.executors.resolveLibraryId).toBe(store.resolveLibraryId);
  });
});
