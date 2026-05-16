import { describe, expect, it } from "vitest";
import { Cause, Effect, Exit, Layer } from "effect";
import type { Config } from "../src/config.js";
import { BotIdentity } from "../src/effect/services/botIdentity.js";
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

const issueCommentData = {
  action: "created",
  installation: { id: 1 },
  repository: { owner: { login: "o" }, name: "r" },
  issue: { number: 1 },
  comment: { id: 99, user: { id: 7 }, body: "" },
} as never;

describe("WebhookHandlers Effect resolution", () => {
  it("propagates BotIdentity failure through Effect's error channel (no Promise escape)", async () => {
    const failingBot = Layer.succeed(
      BotIdentity,
      BotIdentity.of({
        resolve: () => Effect.fail(new Error("bot resolve failed")),
        getUserId: () => Effect.fail(new Error("bot resolve failed")),
      }),
    );

    const HandlersWithFailingBot = WebhookHandlersCore.pipe(Layer.provide(failingBot));

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

  it("short-circuits on bot identity match without invoking downstream side-effects", async () => {
    const selfCommentData = {
      ...issueCommentData,
      comment: { id: 99, user: { id: 42 }, body: "" },
    } as never;

    const constBot = Layer.succeed(
      BotIdentity,
      BotIdentity.of({
        resolve: () => Effect.succeed({ userId: 42, login: "bot" }),
        getUserId: () => Effect.succeed(42),
      }),
    );

    const Handlers = WebhookHandlersCore.pipe(Layer.provide(constBot));

    // If the handler ran further, it would reach createGithubBot/Octokit which would throw.
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
