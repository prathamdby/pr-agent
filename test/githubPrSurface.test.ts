import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestConfig } from "./helpers/config.js";
import {
  resetInstallationOctokitFactory,
  setInstallationOctokitFactory,
} from "../src/github/appAuth.js";
import * as appAuth from "../src/github/appAuth.js";
import * as evlog from "../src/evlog.js";
import * as httpStatusMod from "../src/github/httpStatus.js";
import { createPrSurface } from "../src/github/prSurface.js";
import {
  GITHUB_REACTION_EYES,
  GITHUB_REACTION_MINUS_ONE,
  GITHUB_REACTION_PLUS_ONE,
} from "../src/settings/index.js";

const mocks = {
  createForIssue: vi.fn(),
  listForIssue: vi.fn(),
  deleteForIssue: vi.fn(),
  createForIssueComment: vi.fn(),
  listForIssueComment: vi.fn(),
  deleteForIssueComment: vi.fn(),
  createForPullRequestReviewComment: vi.fn(),
  listForPullRequestReviewComment: vi.fn(),
  deleteForPullRequestComment: vi.fn(),
};

type ReactionListParams = {
  readonly owner?: string;
  readonly repo?: string;
  readonly issue_number?: number;
  readonly comment_id?: number;
  readonly per_page?: number;
  readonly content?: string;
  readonly reaction_id?: number;
};

type ListedReactionRow = {
  readonly id: number;
  readonly content: string;
  readonly user: { readonly id: number } | null;
};

type ReactionPage = {
  readonly data: readonly ListedReactionRow[];
};

type FakeOctokit = {
  readonly rest: {
    readonly reactions: {
      createForIssue: (params: ReactionListParams) => Promise<void>;
      listForIssue: (params: ReactionListParams) => Promise<ReactionPage>;
      deleteForIssue: (params: ReactionListParams) => Promise<void>;
      createForIssueComment: (params: ReactionListParams) => Promise<void>;
      listForIssueComment: (params: ReactionListParams) => Promise<ReactionPage>;
      deleteForIssueComment: (params: ReactionListParams) => Promise<void>;
      createForPullRequestReviewComment: (params: ReactionListParams) => Promise<void>;
      listForPullRequestReviewComment: (params: ReactionListParams) => Promise<ReactionPage>;
      deleteForPullRequestComment: (params: ReactionListParams) => Promise<void>;
    };
  };
  paginate(
    fn: (params: ReactionListParams) => Promise<ReactionPage>,
    params: ReactionListParams,
  ): Promise<readonly ListedReactionRow[]>;
  readonly hook: {
    after: (event: string, handler: () => void) => void;
  };
};

function fakeOctokit(): FakeOctokit {
  const rest = {
    reactions: {
      createForIssue: mocks.createForIssue,
      listForIssue: mocks.listForIssue,
      deleteForIssue: mocks.deleteForIssue,
      createForIssueComment: mocks.createForIssueComment,
      listForIssueComment: mocks.listForIssueComment,
      deleteForIssueComment: mocks.deleteForIssueComment,
      createForPullRequestReviewComment: mocks.createForPullRequestReviewComment,
      listForPullRequestReviewComment: mocks.listForPullRequestReviewComment,
      deleteForPullRequestComment: mocks.deleteForPullRequestComment,
    },
  };
  return {
    rest,
    paginate: async (fn, opts) => {
      const result = await fn(opts);
      return result.data;
    },
    hook: {
      after: vi.fn(),
    },
  };
}

const BOT_USER_ID = 999;

function prSurface() {
  return createPrSurface({
    cfg: makeTestConfig(),
    installationId: 1,
    owner: "o",
    repo: "r",
    prNumber: 7,
    installation: {
      token: "tok",
      expiresAtTs: Date.now() + 3_600_000,
      ttlMs: 3_600_000,
    },
  });
}

describe("PrSurface acknowledgement reactions", () => {
  beforeEach(() => {
    setInstallationOctokitFactory(fakeOctokit);
    vi.spyOn(appAuth, "getAppBotIdentity").mockResolvedValue({
      userId: BOT_USER_ID,
      login: "pr-agent[bot]",
    });
    vi.spyOn(evlog, "logDebug").mockImplementation(() => undefined);
    vi.spyOn(httpStatusMod, "httpStatus");
    vi.clearAllMocks();
    vi.mocked(appAuth.getAppBotIdentity).mockResolvedValue({
      userId: BOT_USER_ID,
      login: "pr-agent[bot]",
    });
    mocks.listForIssue.mockResolvedValue({ data: [] });
    mocks.createForIssue.mockResolvedValue({});
    mocks.deleteForIssue.mockResolvedValue({});
  });

  afterEach(() => {
    resetInstallationOctokitFactory();
  });

  it("posts the requested reaction content", async () => {
    mocks.createForIssue.mockResolvedValue({});
    await prSurface().setAcknowledgementReaction(
      [{ kind: "pr", prNumber: 7 }],
      GITHUB_REACTION_PLUS_ONE,
    );
    expect(mocks.createForIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 7,
        content: GITHUB_REACTION_PLUS_ONE,
      }),
    );
  });

  it("debug-logs suppressed 403 errors", async () => {
    mocks.createForIssue.mockRejectedValue(new Error("forbidden"));
    vi.mocked(httpStatusMod.httpStatus).mockReturnValue(403);

    await expect(
      prSurface().setAcknowledgementReaction([{ kind: "pr", prNumber: 7 }], GITHUB_REACTION_EYES),
    ).resolves.toBeUndefined();

    expect(evlog.logDebug).toHaveBeenCalledWith(
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
    vi.mocked(httpStatusMod.httpStatus).mockReturnValue(422);

    await expect(
      prSurface().setAcknowledgementReaction([{ kind: "pr", prNumber: 7 }], GITHUB_REACTION_EYES),
    ).resolves.toBeUndefined();

    expect(evlog.logDebug).not.toHaveBeenCalled();
  });

  it("continues when one target fails", async () => {
    mocks.listForIssue
      .mockResolvedValueOnce({ data: [] })
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ data: [] });
    vi.mocked(httpStatusMod.httpStatus).mockReturnValue(500);

    await expect(
      prSurface().setAcknowledgementReaction(
        [
          { kind: "pr", prNumber: 1 },
          { kind: "pr", prNumber: 2 },
          { kind: "pr", prNumber: 3 },
        ],
        GITHUB_REACTION_PLUS_ONE,
      ),
    ).resolves.toBeUndefined();

    expect(mocks.listForIssue).toHaveBeenCalledTimes(3);
    expect(evlog.logDebug).toHaveBeenCalledWith(
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

    await prSurface().setAcknowledgementReaction(
      [{ kind: "pr", prNumber: 7 }],
      GITHUB_REACTION_PLUS_ONE,
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

    await prSurface().setAcknowledgementReaction(
      [{ kind: "pr", prNumber: 7 }],
      GITHUB_REACTION_MINUS_ONE,
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

    await prSurface().setAcknowledgementReaction(
      [{ kind: "pr", prNumber: 7 }],
      GITHUB_REACTION_PLUS_ONE,
    );

    expect(mocks.createForIssue).not.toHaveBeenCalled();
    expect(mocks.deleteForIssue).not.toHaveBeenCalled();
  });

  it("creates without deletes when bot identity is unavailable", async () => {
    vi.mocked(appAuth.getAppBotIdentity).mockRejectedValue(new Error("no bot"));

    await prSurface().setAcknowledgementReaction(
      [{ kind: "pr", prNumber: 7 }],
      GITHUB_REACTION_PLUS_ONE,
    );

    expect(mocks.listForIssue).not.toHaveBeenCalled();
    expect(mocks.deleteForIssue).not.toHaveBeenCalled();
    expect(mocks.createForIssue).toHaveBeenCalledWith(
      expect.objectContaining({ content: GITHUB_REACTION_PLUS_ONE }),
    );
  });

  it("replaces eyes on an issueComment target", async () => {
    mocks.listForIssueComment.mockResolvedValue({
      data: [{ id: 41, content: GITHUB_REACTION_EYES, user: { id: BOT_USER_ID } }],
    });
    mocks.createForIssueComment.mockResolvedValue({});
    mocks.deleteForIssueComment.mockResolvedValue({});

    await prSurface().setAcknowledgementReaction(
      [{ kind: "issueComment", commentId: 55 }],
      GITHUB_REACTION_PLUS_ONE,
    );

    expect(mocks.listForIssueComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 55 }),
    );
    expect(mocks.deleteForIssueComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 55, reaction_id: 41 }),
    );
    expect(mocks.createForIssueComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 55, content: GITHUB_REACTION_PLUS_ONE }),
    );
  });

  it("replaces eyes on a reviewComment target", async () => {
    mocks.listForPullRequestReviewComment.mockResolvedValue({
      data: [{ id: 51, content: GITHUB_REACTION_EYES, user: { id: BOT_USER_ID } }],
    });
    mocks.createForPullRequestReviewComment.mockResolvedValue({});
    mocks.deleteForPullRequestComment.mockResolvedValue({});

    await prSurface().setAcknowledgementReaction(
      [{ kind: "reviewComment", commentId: 66 }],
      GITHUB_REACTION_PLUS_ONE,
    );

    expect(mocks.listForPullRequestReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 66 }),
    );
    expect(mocks.deleteForPullRequestComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 66, reaction_id: 51 }),
    );
    expect(mocks.createForPullRequestReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 66, content: GITHUB_REACTION_PLUS_ONE }),
    );
  });

  it("logs and continues when a deleteReaction fails during replacement", async () => {
    mocks.listForIssue.mockResolvedValue({
      data: [
        { id: 61, content: GITHUB_REACTION_EYES, user: { id: BOT_USER_ID } },
        { id: 62, content: GITHUB_REACTION_MINUS_ONE, user: { id: BOT_USER_ID } },
      ],
    });
    mocks.createForIssue.mockResolvedValue({});
    mocks.deleteForIssue
      .mockRejectedValueOnce(new Error("delete failed"))
      .mockResolvedValueOnce({});
    vi.mocked(httpStatusMod.httpStatus).mockReturnValue(500);

    await expect(
      prSurface().setAcknowledgementReaction(
        [{ kind: "pr", prNumber: 7 }],
        GITHUB_REACTION_PLUS_ONE,
      ),
    ).resolves.toBeUndefined();

    expect(evlog.logDebug).toHaveBeenCalledWith(
      "ack_reaction_failed",
      expect.objectContaining({ reaction: GITHUB_REACTION_PLUS_ONE }),
    );
    expect(mocks.createForIssue).not.toHaveBeenCalled();
  });
});
