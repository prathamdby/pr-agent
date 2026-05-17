import { describe, expect, it } from "vitest";
import { Cause, Effect, Exit, Layer } from "effect";
import type { Config } from "../src/config.js";
import { BotIdentity } from "../src/effect/services/botIdentity.js";
import { PrGithubSurface } from "../src/effect/services/prGithubSurface.js";
import { WebhookHandlers, WebhookHandlersCore } from "../src/effect/services/webhookHandlers.js";

const cfg: Config = {
  port: 0,
  githubAppId: "1",
  githubAppPrivateKey: "k",
  webhookSecret: "s",
  piProvider: "openai",
  piModel: "gpt-4o-mini",
  maxToolRounds: 24,
  maxFinalizeRounds: 6,
  reviewConcurrency: 2,
  webhookTimeoutMs: 10000,
  logLevel: "error",
};

// `/help` body forces the slash flow past the early parse exit, so the bot-id
// fetch and downstream guards are actually exercised.
const issueCommentData = {
  action: "created",
  installation: { id: 1 },
  repository: { owner: { login: "o" }, name: "r" },
  issue: { number: 1 },
  comment: { id: 99, user: { id: 7 }, body: "/help" },
} as never;

const explodingSurface = Layer.succeed(
  PrGithubSurface,
  PrGithubSurface.of({
    acknowledgeOnPrConversation: () => Effect.die("PrGithubSurface must not be called"),
    acknowledgeOnIssueComment: () => Effect.die("PrGithubSurface must not be called"),
    acknowledgeOnReviewComment: () => Effect.die("PrGithubSurface must not be called"),
    postPrConversationComment: () => Effect.die("PrGithubSurface must not be called"),
    replyOnInlineReviewThread: () => Effect.die("PrGithubSurface must not be called"),
    getPullRequestHeadSha: () => Effect.die("PrGithubSurface must not be called"),
  }),
);

describe("WebhookHandlers Effect resolution", () => {
  it("propagates BotIdentity failure through Effect's error channel (no Promise escape)", async () => {
    const failingBot = Layer.succeed(
      BotIdentity,
      BotIdentity.of({
        resolve: () => Effect.fail(new Error("bot resolve failed")),
        getUserId: () => Effect.fail(new Error("bot resolve failed")),
      }),
    );

    const HandlersWithFailingBot = WebhookHandlersCore.pipe(
      Layer.provide(failingBot),
      Layer.provide(explodingSurface),
    );

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const handlers = yield* WebhookHandlers;
        yield* handlers.issueComment(cfg, "token", issueCommentData);
      }).pipe(Effect.provide(HandlersWithFailingBot)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect((failure.value as Error).message).toBe("bot resolve failed");
      }
    }
  });

  it("short-circuits on bot identity match without invoking PrGithubSurface", async () => {
    const selfCommentData = {
      ...issueCommentData,
      comment: { id: 99, user: { id: 42 }, body: "/help" },
    } as never;

    const constBot = Layer.succeed(
      BotIdentity,
      BotIdentity.of({
        resolve: () => Effect.succeed({ userId: 42, login: "bot" }),
        getUserId: () => Effect.succeed(42),
      }),
    );

    const Handlers = WebhookHandlersCore.pipe(
      Layer.provide(constBot),
      Layer.provide(explodingSurface),
    );

    // The exploding surface dies if any acknowledgement / post call runs.
    // A clean Exit.success proves the bot-id guard short-circuited before any GitHub I/O.
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const handlers = yield* WebhookHandlers;
        yield* handlers.issueComment(cfg, "token", selfCommentData);
      }).pipe(Effect.provide(Handlers)),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });
});
