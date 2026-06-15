import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { createOperationLogger } from "../src/evlog.js";
import { processWebhookPostRequestEffect } from "../src/effect/programs/processWebhookRequestEffect.js";
import { IntakeLogger } from "../src/effect/server.js";
import { AgentWorkScheduler } from "../src/agentWork/scheduler.js";
import { WebhookHandlers } from "../src/effect/services/webhookHandlers.js";
import { makeTestConfig } from "./helpers/config.js";

const cfg = makeTestConfig({
  webhookSecret: "secret",
  maxAskFinalizeRounds: 6,
  enableReviewLabelsEffort: false,
});

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

function sign(secret: string, body: Buffer): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("effect webhook program integration", () => {
  it("returns 200 for valid ignored webhook", async () => {
    const payload = { installation: { id: 1 } };
    const body = Buffer.from(JSON.stringify(payload));

    const res = await Effect.runPromise(
      processWebhookPostRequestEffect(cfg, {
        headers: {
          "x-hub-signature-256": sign(cfg.webhookSecret, body),
          "x-github-event": "ping",
          "x-github-delivery": "d1",
        },
        rawBody: body,
      }).pipe(
        Effect.provide(intakeLayer),
        Effect.provideService(
          IntakeLogger,
          createOperationLogger({
            method: "POST",
            path: "/webhooks",
            requestId: "d1",
          }),
        ),
      ),
    );

    expect(res.status).toBe(200);
    expect(res.body).toBe("ok");
  });
});
