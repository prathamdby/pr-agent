import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createForIssue: vi.fn(),
  logDebug: vi.fn(),
  httpStatus: vi.fn(),
}));

vi.mock("../src/github/appAuth.js", () => ({
  getAppBotIdentity: vi.fn(),
  installationOctokit: () => ({
    rest: {
      reactions: {
        createForIssue: mocks.createForIssue,
        createForIssueComment: vi.fn(),
        createForPullRequestReviewComment: vi.fn(),
      },
    },
  }),
}));

vi.mock("../src/evlog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/evlog.js")>();
  return { ...actual, logDebug: mocks.logDebug };
});

vi.mock("../src/github/httpStatus.js", () => ({
  httpStatus: mocks.httpStatus,
}));

import { safeReaction } from "../src/agentWork/githubPrSurface.js";

describe("safeReaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("debug-logs suppressed 403 errors", async () => {
    mocks.createForIssue.mockRejectedValue(new Error("forbidden"));
    mocks.httpStatus.mockReturnValue(403);

    await expect(
      safeReaction("tok", "o", "r", { kind: "pr", prNumber: 7 }),
    ).resolves.toBeUndefined();

    expect(mocks.logDebug).toHaveBeenCalledWith(
      "reaction_suppressed_forbidden",
      expect.objectContaining({
        owner: "o",
        repo: "r",
        target: { kind: "pr", prNumber: 7 },
        status: 403,
      }),
    );
  });

  it("keeps 422 silent", async () => {
    mocks.createForIssue.mockRejectedValue(new Error("already reacted"));
    mocks.httpStatus.mockReturnValue(422);

    await expect(
      safeReaction("tok", "o", "r", { kind: "pr", prNumber: 7 }),
    ).resolves.toBeUndefined();

    expect(mocks.logDebug).not.toHaveBeenCalled();
  });
});
