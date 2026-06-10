import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { WebhookDispatcher } from "../src/effect/services/webhookDispatcher.js";
import { createOperationLogger } from "../src/evlog.js";
import { IntakeLogger } from "../src/effect/intakeLogger.js";
import { makeTestConfig } from "./helpers/config.js";

const cfg = makeTestConfig({
  port: 3000,
  maxAskFinalizeRounds: 6,
  enableReviewLabelsEffort: false,
});

const dispatcherLayer = Layer.succeed(
  WebhookDispatcher,
  WebhookDispatcher.of({
    dispatch: () => Effect.void,
    ping: () => Effect.succeed(true),
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

    await Effect.runPromise(
      program.pipe(
        Effect.provide(dispatcherLayer),
        Effect.provideService(
          IntakeLogger,
          createOperationLogger({ method: "POST", path: "/webhooks" }),
        ),
      ),
    );
  });
});
