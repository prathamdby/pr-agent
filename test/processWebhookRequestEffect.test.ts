import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Effect, Layer } from "effect";
import type { Config } from "../src/config.js";
import { processWebhookHttpRequestEffect } from "../src/effect/programs/processWebhookRequestEffect.js";
import { WebhookDispatcher } from "../src/effect/services/webhookDispatcher.js";
import { WebhookHandlerError } from "../src/effect/errors.js";
import { log } from "../src/log.js";

const cfg: Config = {
  port: 0,
  githubAppId: "1",
  githubAppPrivateKey: "fake",
  webhookSecret: "secret",
  piProvider: "openai",
  piModel: "gpt-4o-mini",
  maxToolRounds: 24,
  maxFinalizeRounds: 6,
  reviewConcurrency: 2,
  webhookTimeoutMs: 10000,
  logLevel: "error",
};

function sign(body: Buffer): string {
  return `sha256=${crypto.createHmac("sha256", cfg.webhookSecret).update(body).digest("hex")}`;
}

describe("processWebhookHttpRequestEffect", () => {
  const stubDispatcherLayer = Layer.succeed(
    WebhookDispatcher,
    WebhookDispatcher.of({
      dispatch: () => Effect.void,
    }),
  );

  it("returns health response", async () => {
    const out = await Effect.runPromise(
      processWebhookHttpRequestEffect(cfg, {
        method: "GET",
        url: "/health",
        headers: {},
        rawBody: Buffer.alloc(0),
      }).pipe(Effect.provide(stubDispatcherLayer)),
    );

    expect(out).toEqual({ status: 200, body: "ok", contentType: "text/plain; charset=utf-8" });
  });

  it("returns invalid signature", async () => {
    const body = Buffer.from("{}");
    const out = await Effect.runPromise(
      processWebhookHttpRequestEffect(cfg, {
        method: "POST",
        url: "/webhooks",
        headers: { "x-hub-signature-256": "sha256=bad" },
        rawBody: body,
      }).pipe(Effect.provide(stubDispatcherLayer)),
    );

    expect(out).toEqual({ status: 401, body: "invalid signature" });
  });

  it("returns ok for valid webhook", async () => {
    const body = Buffer.from(JSON.stringify({ installation: { id: 1 } }));
    const out = await Effect.runPromise(
      processWebhookHttpRequestEffect(cfg, {
        method: "POST",
        url: "/webhooks",
        headers: { "x-hub-signature-256": sign(body), "x-github-event": "ping" },
        rawBody: body,
      }).pipe(Effect.provide(stubDispatcherLayer)),
    );

    expect(out).toEqual({ status: 200, body: "ok" });
  });

  it("warns when handling exceeds the timeout budget", async () => {
    const slowDispatcherLayer = Layer.succeed(
      WebhookDispatcher,
      WebhookDispatcher.of({
        dispatch: () => Effect.sleep("20 millis"),
      }),
    );

    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    const tightCfg: Config = { ...cfg, webhookTimeoutMs: 1 };
    const body = Buffer.from(JSON.stringify({ installation: { id: 1 } }));

    try {
      await Effect.runPromise(
        processWebhookHttpRequestEffect(tightCfg, {
          method: "POST",
          url: "/webhooks",
          headers: { "x-hub-signature-256": sign(body), "x-github-event": "ping" },
          rawBody: body,
        }).pipe(Effect.provide(slowDispatcherLayer)),
      );

      const budgetWarn = warnSpy.mock.calls.find((c) => c[0] === "webhook_timeout_budget_exceeded");
      expect(budgetWarn).toBeDefined();
      expect(budgetWarn?.[1]).toMatchObject({ budgetMs: 1 });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("returns 500 when dispatcher fails with WebhookHandlerError", async () => {
    const failingDispatcherLayer = Layer.succeed(
      WebhookDispatcher,
      WebhookDispatcher.of({
        dispatch: () => Effect.fail(new WebhookHandlerError({ cause: new Error("boom"), message: "boom" })),
      }),
    );

    const errorSpy = vi.spyOn(log, "error").mockImplementation(() => {});
    const body = Buffer.from(JSON.stringify({ installation: { id: 1 } }));

    try {
      const out = await Effect.runPromise(
        processWebhookHttpRequestEffect(cfg, {
          method: "POST",
          url: "/webhooks",
          headers: { "x-hub-signature-256": sign(body), "x-github-event": "ping" },
          rawBody: body,
        }).pipe(Effect.provide(failingDispatcherLayer)),
      );

      expect(out).toEqual({ status: 500, body: "internal error" });
      const errLog = errorSpy.mock.calls.find((c) => c[0] === "webhook_handler_error");
      expect(errLog).toBeDefined();
      expect(errLog?.[1]).toMatchObject({ message: "boom" });
    } finally {
      errorSpy.mockRestore();
    }
  });
});
