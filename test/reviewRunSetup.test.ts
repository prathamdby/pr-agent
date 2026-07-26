import { describe, expect, it, vi } from "vitest";
import type { LocalPrWorkspace } from "../src/prWorkspace/index.js";
import { buildCheckoutCoverage } from "../src/prWorkspace/localPrWorkspace.js";
import { buildReviewRunSetup } from "../src/review/run/reviewRunSetup.js";
import { makeTestConfig } from "./helpers/config.js";

const workspace: LocalPrWorkspace = {
  rootDir: "/tmp/review-run-setup",
  privateGitDir: "/tmp/review-run-setup/.git",
  agentCwd: "/tmp/review-run-setup/agent",
  changedFiles: [],
  changedFileByPath: new Map(),
  checkoutPaths: new Set(),
  sortedCheckoutPaths: [],
  checkoutMode: "full",
  diffIndex: { files: new Map(), truncated: false, listPullRequestFilesIngested: false },
  stats: { truncated: false, totalChanges: 0, fileCount: 0 },
  grepLiteral: async () => ({ matches: [], truncated: false }),
  getDiffForPath: async () => "",
  getBlameForPath: async () => "",
  isPathInCheckout: () => false,
  getCoverage: () =>
    buildCheckoutCoverage({
      checkoutMode: "full",
      checkoutPaths: new Set(),
      changedFiles: [],
      stats: { truncated: false },
    }),
  noteSearchTruncated: () => undefined,
  lookupSymbol: () => [],
  getSymbolIndexStatus: () => ({ available: false }),
  cleanup: async () => undefined,
};

describe("buildReviewRunSetup", () => {
  it("exposes exploration tools and a live auth refresh", async () => {
    const refreshInstallationToken = vi.fn(async () => ({
      token: "fresh-token",
      expiresAtTs: Date.now() + 60_000,
    }));
    const setup = buildReviewRunSetup({
      cfg: makeTestConfig(),
      token: "old-token",
      tokenExpiresAtTs: Date.now() - 1,
      tokenTtlMs: 60_000,
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "a".repeat(40),
      workspace,
      refreshInstallationToken,
    });

    expect(setup.workspaceTools.piTools.map((tool) => tool.name)).not.toContain("submitReview");
    expect(setup.orchestratorUserContent).not.toContain("submitReview");

    await setup.refreshLiveAuth();

    expect(refreshInstallationToken).toHaveBeenCalledOnce();
    expect(setup.getToken()).toBe("fresh-token");
  });
});
