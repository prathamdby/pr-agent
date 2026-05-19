import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { Config } from "../src/config.js";
import { processWebhookHttpRequestEffect } from "../src/effect/programs/processWebhookRequestEffect.js";
import { buildWebhookDispatcherLive } from "../src/effect/services/webhookDispatcher.js";

const cfg: Config = {
  port: 0,
  githubAppId: "1",
  githubAppPrivateKey: "fake",
  webhookSecret: "secret",
  piProvider: "openai",
  piModel: "gpt-4o-mini",
  maxToolRounds: 24,
  maxFinalizeRounds: 6,
  maxReviewPublishAttempts: 3,
  reviewConcurrency: 2,
	askConcurrency: 3,
	maxAskToolRounds: 12,
  webhookTimeoutMs: 10000,
  logLevel: "error",
};

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
      }).pipe(Effect.provide(buildWebhookDispatcherLive(cfg))),
    );

    expect(res.status).toBe(200);
    expect(res.body).toBe("ok");
  });
});
