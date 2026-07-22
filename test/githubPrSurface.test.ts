import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createForIssue: vi.fn(),
  listForIssue: vi.fn(),
  deleteForIssue: vi.fn(),
  createForIssueComment: vi.fn(),
  listForIssueComment: vi.fn(),
  deleteForIssueComment: vi.fn(),
  createForPullRequestReviewComment: vi.fn(),
  listForPullRequestReviewComment: vi.fn(),
  deleteForPullRequestReviewComment: vi.fn(),
  logDebug: vi.fn(),
  httpStatus: vi.fn(),
}));

vi.mock("../src/github/appAuth.js", () => ({
  getAppBotIdentity: vi.fn(),
  installationOctokit: () => ({
    rest: {
      reactions: {
        createForIssue: mocks.createForIssue,
        listForIssue: mocks.listForIssue,
        deleteForIssue: mocks.deleteForIssue,
        createForIssueComment: mocks.createForIssueComment,
        listForIssueComment: mocks.listForIssueComment,
        deleteForIssueComment: mocks.deleteForIssueComment,
        createForPullRequestReviewComment: mocks.createForPullRequestReviewComment,
        listForPullRequestReviewComment: mocks.listForPullRequestReviewComment,
        deleteForPullRequestReviewComment: mocks.deleteForPullRequestReviewComment,
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
import {
  GITHUB_REACTION_EYES,
  GITHUB_REACTION_MINUS_ONE,
  GITHUB_REACTION_PLUS_ONE,
} from "../src/settings/index.js";

const BOT_USER_ID = 999;

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
    mocks.listForIssue.mockResolvedValue({ data: [] });
    mocks.createForIssue.mockResolvedValue({});
    mocks.deleteForIssue.mockResolvedValue({});
  });

  it("continues when one target fails", async () => {
    mocks.listForIssue
      .mockResolvedValueOnce({ data: [] })
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ data: [] });
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
        BOT_USER_ID,
      ),
    ).resolves.toBeUndefined();

    expect(mocks.listForIssue).toHaveBeenCalledTimes(3);
    expect(mocks.logDebug).toHaveBeenCalledWith(
      "ack_reaction_failed",
      expect.objectContaining({ reaction: GITHUB_REACTION_PLUS_ONE }),
    );
  });

  it("replaces eyes with plus-one atomically for the bot", async () => {
    mocks.listForIssue.mockResolvedValue({
      data: [
        { id: 11, content: GITHUB_REACTION_EYES, user: { id: BOT_USER_ID } },
        { id: 12, content: "heart", user: { id: BOT_USER_ID } },
        { id: 13, content: GITHUB_REACTION_EYES, user: { id: 42 } },
      ],
    });

    await reactOnAckTargets(
      "tok",
      "o",
      "r",
      [{ kind: "pr", prNumber: 7 }],
      GITHUB_REACTION_PLUS_ONE,
      BOT_USER_ID,
    );

    expect(mocks.deleteForIssue).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 7, reaction_id: 11 }),
    );
    expect(mocks.deleteForIssue).not.toHaveBeenCalledWith(
      expect.objectContaining({ reaction_id: 12 }),
    );
    expect(mocks.deleteForIssue).not.toHaveBeenCalledWith(
      expect.objectContaining({ reaction_id: 13 }),
    );
    expect(mocks.createForIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 7,
        content: GITHUB_REACTION_PLUS_ONE,
      }),
    );
  });

  it("replaces eyes with minus-one on failure without stacking", async () => {
    mocks.listForIssue.mockResolvedValue({
      data: [{ id: 21, content: GITHUB_REACTION_EYES, user: { id: BOT_USER_ID } }],
    });

    await reactOnAckTargets(
      "tok",
      "o",
      "r",
      [{ kind: "pr", prNumber: 7 }],
      GITHUB_REACTION_MINUS_ONE,
      BOT_USER_ID,
    );

    expect(mocks.deleteForIssue).toHaveBeenCalledWith(expect.objectContaining({ reaction_id: 21 }));
    expect(mocks.createForIssue).toHaveBeenCalledWith(
      expect.objectContaining({ content: GITHUB_REACTION_MINUS_ONE }),
    );
  });

  it("skips create when the desired lifecycle reaction already exists", async () => {
    mocks.listForIssue.mockResolvedValue({
      data: [{ id: 31, content: GITHUB_REACTION_PLUS_ONE, user: { id: BOT_USER_ID } }],
    });

    await reactOnAckTargets(
      "tok",
      "o",
      "r",
      [{ kind: "pr", prNumber: 7 }],
      GITHUB_REACTION_PLUS_ONE,
      BOT_USER_ID,
    );

    expect(mocks.createForIssue).not.toHaveBeenCalled();
    expect(mocks.deleteForIssue).not.toHaveBeenCalled();
  });

  it("creates without deletes when botUserId is unavailable", async () => {
    await reactOnAckTargets(
      "tok",
      "o",
      "r",
      [{ kind: "pr", prNumber: 7 }],
      GITHUB_REACTION_PLUS_ONE,
      undefined,
    );

    expect(mocks.listForIssue).not.toHaveBeenCalled();
    expect(mocks.deleteForIssue).not.toHaveBeenCalled();
    expect(mocks.createForIssue).toHaveBeenCalledWith(
      expect.objectContaining({ content: GITHUB_REACTION_PLUS_ONE }),
    );
  });
});
