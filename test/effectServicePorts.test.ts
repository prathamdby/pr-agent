import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { AgentWorkScheduler } from "../src/agentWork/scheduler.js";
import { WebhookHandlers } from "../src/effect/services/webhookHandlers.js";

const intakeLayer = Layer.mergeAll(
  Layer.succeed(
    AgentWorkScheduler,
    AgentWorkScheduler.of({
      recordIgnored: () => Effect.void,
      submitAutomatedReview: () => Effect.void,
      submitSlashCommand: () => Effect.void,
      matchesStoredInlineReview: () => Effect.succeed(false),
      ping: () => Effect.succeed(true),
    }),
  ),
  Layer.succeed(
    WebhookHandlers,
    WebhookHandlers.of({
      pullRequest: () => Effect.void,
      issueComment: () => Effect.void,
      pullRequestReviewComment: () => Effect.void,
    }),
  ),
);

describe("effect service ports", () => {
  it("provides AgentWorkScheduler and WebhookHandlers", async () => {
    const program = Effect.gen(function* () {
      const scheduler = yield* AgentWorkScheduler;
      const handlers = yield* WebhookHandlers;
      expect(typeof scheduler.ping).toBe("function");
      expect(typeof handlers.pullRequest).toBe("function");
    });

    await Effect.runPromise(program.pipe(Effect.provide(intakeLayer)));
  });
});
