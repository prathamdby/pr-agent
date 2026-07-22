import { describe, expect, it, vi } from "vitest";
import type { LocalPrWorkspace } from "../src/prWorkspace/index.js";
import { createSubmitReviewState } from "../src/review/publish/submitReviewTool.js";
import { buildReviewRunSetup, shouldContinueReviewRun } from "../src/review/run/reviewRunSetup.js";
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
  cleanup: async () => undefined,
};

describe("shouldContinueReviewRun", () => {
  it("returns false when publishSuperseded is set", () => {
    const submitState = createSubmitReviewState();
    submitState.publishSuperseded = true;
    expect(shouldContinueReviewRun({ submitState })).toBe(false);
  });

  it("returns false when already published", () => {
    const submitState = createSubmitReviewState({ published: true });
    expect(shouldContinueReviewRun({ submitState })).toBe(false);
  });

  it("returns true while unpublished and not superseded", () => {
    const submitState = createSubmitReviewState();
    expect(shouldContinueReviewRun({ submitState })).toBe(true);
  });
});

describe("buildReviewRunSetup", () => {
  it("exposes exploration tools without submitReview and a live auth refresh", async () => {
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
      reviewMode: "review",
      workspace,
      refreshInstallationToken,
    });

    expect(setup.piTools.map((tool) => tool.name)).toContain("submitReview");
    expect(setup.workspaceTools.piTools.map((tool) => tool.name)).not.toContain("submitReview");
    expect(setup.workspaceTools.executors.submitReview).toBeUndefined();
    expect(setup.orchestratorUserContent).not.toContain("submitReview");

    await setup.refreshLiveAuth();

    expect(refreshInstallationToken).toHaveBeenCalledOnce();
    expect(setup.getToken()).toBe("fresh-token");
  });
});
