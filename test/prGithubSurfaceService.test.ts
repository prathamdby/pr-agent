import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import * as appAuth from "../src/github/appAuth.js";
import { PrGithubSurface, PrGithubSurfaceLive } from "../src/effect/services/prGithubSurface.js";

function makeOctokitStub(
  overrides: Partial<{
    createForIssue: ReturnType<typeof vi.fn>;
    createForIssueComment: ReturnType<typeof vi.fn>;
    createForPullRequestReviewComment: ReturnType<typeof vi.fn>;
    createComment: ReturnType<typeof vi.fn>;
    createReplyForReviewComment: ReturnType<typeof vi.fn>;
    pullsGet: ReturnType<typeof vi.fn>;
  }> = {},
) {
  return {
    rest: {
      reactions: {
        createForIssue: overrides.createForIssue ?? vi.fn().mockResolvedValue({}),
        createForIssueComment: overrides.createForIssueComment ?? vi.fn().mockResolvedValue({}),
        createForPullRequestReviewComment:
          overrides.createForPullRequestReviewComment ?? vi.fn().mockResolvedValue({}),
      },
      issues: { createComment: overrides.createComment ?? vi.fn().mockResolvedValue({}) },
      pulls: {
        createReplyForReviewComment:
          overrides.createReplyForReviewComment ?? vi.fn().mockResolvedValue({}),
        get:
          overrides.pullsGet ?? vi.fn().mockResolvedValue({ data: { head: { sha: "deadbeef" } } }),
      },
    },
  } as unknown as ReturnType<typeof appAuth.installationOctokit>;
}

describe("PrGithubSurface service", () => {
  it("acknowledgeOnPrConversation posts eyes via createForIssue", async () => {
    const createForIssue = vi.fn().mockResolvedValue({});
    const stub = makeOctokitStub({ createForIssue });
    const spy = vi.spyOn(appAuth, "installationOctokit").mockReturnValue(stub);

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* PrGithubSurface;
          yield* svc.acknowledgeOnPrConversation("tok", "o", "r", 42);
        }).pipe(Effect.provide(PrGithubSurfaceLive)),
      );

      expect(createForIssue).toHaveBeenCalledWith({
        owner: "o",
        repo: "r",
        issue_number: 42,
        content: "eyes",
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("swallows 422 reaction errors silently", async () => {
    const err = Object.assign(new Error("Validation Failed"), { status: 422 });
    const createForIssue = vi.fn().mockRejectedValue(err);
    const stub = makeOctokitStub({ createForIssue });
    const spy = vi.spyOn(appAuth, "installationOctokit").mockReturnValue(stub);

    try {
      await expect(
        Effect.runPromise(
          Effect.gen(function* () {
            const svc = yield* PrGithubSurface;
            yield* svc.acknowledgeOnPrConversation("tok", "o", "r", 1);
          }).pipe(Effect.provide(PrGithubSurfaceLive)),
        ),
      ).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("swallows 403 reaction errors silently", async () => {
    const err = Object.assign(new Error("Forbidden"), { status: 403 });
    const createForIssueComment = vi.fn().mockRejectedValue(err);
    const stub = makeOctokitStub({ createForIssueComment });
    const spy = vi.spyOn(appAuth, "installationOctokit").mockReturnValue(stub);

    try {
      await expect(
        Effect.runPromise(
          Effect.gen(function* () {
            const svc = yield* PrGithubSurface;
            yield* svc.acknowledgeOnIssueComment("tok", "o", "r", 99);
          }).pipe(Effect.provide(PrGithubSurfaceLive)),
        ),
      ).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("propagates non-suppressed reaction errors", async () => {
    const err = Object.assign(new Error("Server Error"), { status: 500 });
    const createForPullRequestReviewComment = vi.fn().mockRejectedValue(err);
    const stub = makeOctokitStub({ createForPullRequestReviewComment });
    const spy = vi.spyOn(appAuth, "installationOctokit").mockReturnValue(stub);

    try {
      await expect(
        Effect.runPromise(
          Effect.gen(function* () {
            const svc = yield* PrGithubSurface;
            yield* svc.acknowledgeOnReviewComment("tok", "o", "r", 7);
          }).pipe(Effect.provide(PrGithubSurfaceLive)),
        ),
      ).rejects.toThrow(/Server Error/);
    } finally {
      spy.mockRestore();
    }
  });

  it("postPrConversationComment posts via issues.createComment", async () => {
    const createComment = vi.fn().mockResolvedValue({});
    const stub = makeOctokitStub({ createComment });
    const spy = vi.spyOn(appAuth, "installationOctokit").mockReturnValue(stub);

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* PrGithubSurface;
          yield* svc.postPrConversationComment("tok", "o", "r", 3, "hi");
        }).pipe(Effect.provide(PrGithubSurfaceLive)),
      );

      expect(createComment).toHaveBeenCalledWith({
        owner: "o",
        repo: "r",
        issue_number: 3,
        body: "hi",
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("replyOnInlineReviewThread posts via pulls.createReplyForReviewComment", async () => {
    const createReplyForReviewComment = vi.fn().mockResolvedValue({ data: { id: 456 } });
    const stub = makeOctokitStub({ createReplyForReviewComment });
    const spy = vi.spyOn(appAuth, "installationOctokit").mockReturnValue(stub);

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* PrGithubSurface;
          yield* svc.replyOnInlineReviewThread("tok", "o", "r", 3, 100, "reply");
        }).pipe(Effect.provide(PrGithubSurfaceLive)),
      );

      expect(createReplyForReviewComment).toHaveBeenCalledWith({
        owner: "o",
        repo: "r",
        pull_number: 3,
        comment_id: 100,
        body: "reply",
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("getPullRequestHeadSha returns data.head.sha", async () => {
    const pullsGet = vi.fn().mockResolvedValue({ data: { head: { sha: "cafef00d" } } });
    const stub = makeOctokitStub({ pullsGet });
    const spy = vi.spyOn(appAuth, "installationOctokit").mockReturnValue(stub);

    try {
      const sha = await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* PrGithubSurface;
          return yield* svc.getPullRequestHeadSha("tok", "o", "r", 3);
        }).pipe(Effect.provide(PrGithubSurfaceLive)),
      );

      expect(sha).toBe("cafef00d");
      expect(pullsGet).toHaveBeenCalledWith({ owner: "o", repo: "r", pull_number: 3 });
    } finally {
      spy.mockRestore();
    }
  });
});
