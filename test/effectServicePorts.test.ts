import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { WebhookDispatcher, WebhookDispatcherLive } from "../src/effect/services/webhookDispatcher.js";
import type { Config } from "../src/config.js";

const cfg: Config = {
  port: 3000,
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

describe("effect service ports", () => {
  it("provides WebhookDispatcher service", async () => {
    const program = Effect.gen(function* () {
      const dispatcher = yield* WebhookDispatcher;
      expect(typeof dispatcher.dispatch).toBe("function");
    });

    await Effect.runPromise(program.pipe(Effect.provide(WebhookDispatcherLive)));
  });

  it("dispatcher handles parse errors without throwing", async () => {
    const program = Effect.gen(function* () {
      const dispatcher = yield* WebhookDispatcher;
      yield* dispatcher.dispatch({
        cfg,
        headers: { event: "pull_request", rawBody: Buffer.from("{}") },
        payload: {},
      });
    });

    await Effect.runPromise(program.pipe(Effect.provide(WebhookDispatcherLive)));
  });
});
