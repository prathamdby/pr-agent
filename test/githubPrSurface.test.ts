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

import { reactOnAckTargets, safeReaction } from "../src/agentWork/githubPrSurface.js";
import { GITHUB_REACTION_EYES, GITHUB_REACTION_PLUS_ONE } from "../src/settings/index.js";

describe("safeReaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("posts the requested reaction content", async () => {
    mocks.createForIssue.mockResolvedValue({});
    await safeReaction("tok", "o", "r", { kind: "pr", prNumber: 7 }, GITHUB_REACTION_PLUS_ONE);
    expect(mocks.createForIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 7,
        content: GITHUB_REACTION_PLUS_ONE,
      }),
    );
  });

  it("debug-logs suppressed 403 errors", async () => {
    mocks.createForIssue.mockRejectedValue(new Error("forbidden"));
    mocks.httpStatus.mockReturnValue(403);

    await expect(
      safeReaction("tok", "o", "r", { kind: "pr", prNumber: 7 }, GITHUB_REACTION_EYES),
    ).resolves.toBeUndefined();

    expect(mocks.logDebug).toHaveBeenCalledWith(
      "reaction_suppressed_forbidden",
      expect.objectContaining({
        owner: "o",
        repo: "r",
        target: { kind: "pr", prNumber: 7 },
        reaction: GITHUB_REACTION_EYES,
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

describe("reactOnAckTargets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("continues when one target fails", async () => {
    mocks.createForIssue
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({});
    mocks.httpStatus.mockReturnValue(500);

    await expect(
      reactOnAckTargets(
        "tok",
        "o",
        "r",
        [
          { kind: "pr", prNumber: 1 },
          { kind: "pr", prNumber: 2 },
          { kind: "pr", prNumber: 3 },
        ],
        GITHUB_REACTION_PLUS_ONE,
      ),
    ).resolves.toBeUndefined();

    expect(mocks.createForIssue).toHaveBeenCalledTimes(3);
    expect(mocks.logDebug).toHaveBeenCalledWith(
      "ack_reaction_failed",
      expect.objectContaining({ reaction: GITHUB_REACTION_PLUS_ONE }),
    );
  });
});
