import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { Config } from "../src/config.js";
import { createOperationLogger } from "../src/evlog.js";
import { processWebhookHttpRequestEffect } from "../src/effect/programs/processWebhookRequestEffect.js";
import { IntakeLogger } from "../src/effect/intakeLogger.js";
import { WebhookDispatcher } from "../src/effect/services/webhookDispatcher.js";
import { Layer } from "effect";

const cfg: Config = {
  port: 0,
  githubAppId: "1",
  githubAppPrivateKey: "fake",
  webhookSecret: "secret",
  databaseUrl: "postgres://test",
  role: "web",
  piProvider: "openai",
  piModel: "gpt-4o-mini",
  maxToolRounds: 24,
  maxFinalizeRounds: 6,
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

function sign(secret: string, body: Buffer): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("effect webhook program integration", () => {
  it("returns 200 for valid ignored webhook", async () => {
    const payload = { installation: { id: 1 } };
    const body = Buffer.from(JSON.stringify(payload));

    const res = await Effect.runPromise(
      processWebhookHttpRequestEffect(cfg, {
        method: "POST",
        url: "/webhooks",
        headers: {
          "x-hub-signature-256": sign(cfg.webhookSecret, body),
          "x-github-event": "ping",
          "x-github-delivery": "d1",
        },
        rawBody: body,
      }).pipe(
        Effect.provide(dispatcherLayer),
        Effect.provideService(
          IntakeLogger,
          createOperationLogger({ method: "POST", path: "/webhooks", requestId: "d1" }),
        ),
      ),
    );

    expect(res.status).toBe(200);
    expect(res.body).toBe("ok");
  });
});
