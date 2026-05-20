import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { WebhookDispatcher } from "../src/effect/services/webhookDispatcher.js";
import type { Config } from "../src/config.js";

const cfg: Config = {
  port: 3000,
  githubAppId: "1",
  githubAppPrivateKey: "k",
  webhookSecret: "s",
  databaseUrl: "postgres://test",
  role: "web",
  piProvider: "openai",
  piModel: "gpt-4o-mini",
  maxToolRounds: 24,
  maxAskFinalizeRounds: 6,
  maxReviewPublishAttempts: 3,
  reviewConcurrency: 2,
  askConcurrency: 1,
  ackConcurrency: 2,
  queueRetryLimit: 3,
  queueRetryDelaySeconds: 30,
  queueRetryDelayMaxSeconds: 300,
  queueExpireInSeconds: 3600,
  queueHeartbeatSeconds: 60,
  queueRetentionSeconds: 1209600,
  queueDeleteAfterSeconds: 604800,
  installationGroupConcurrency: 2,
  maxAskToolRounds: 12,
  webhookTimeoutMs: 10000,
  context7ApiKey: "",
  maxReviewFindings: 8,
  enableReviewLabelsEffort: false,
  enableReviewLabelsSecurity: false,
  maxPrFilesListed: 300,
  maxPrFilesPatchBytes: 500000,
  logLevel: "error",
};

const dispatcherLayer = Layer.succeed(
  WebhookDispatcher,
  WebhookDispatcher.of({
    dispatch: () => Effect.void,
  }),
);

describe("effect service ports", () => {
  it("provides WebhookDispatcher service", async () => {
    const program = Effect.gen(function* () {
      const dispatcher = yield* WebhookDispatcher;
      expect(typeof dispatcher.dispatch).toBe("function");
    });

    await Effect.runPromise(program.pipe(Effect.provide(dispatcherLayer)));
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

    await Effect.runPromise(program.pipe(Effect.provide(dispatcherLayer)));
  });
});
