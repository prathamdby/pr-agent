import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Effect, Layer } from "effect";
import type { Config } from "../src/config.js";
import * as evlog from "../src/evlog.js";
import { IntakeLogger } from "../src/effect/intakeLogger.js";
import { processWebhookHttpRequestEffect } from "../src/effect/programs/processWebhookRequestEffect.js";
import { WebhookDispatcher } from "../src/effect/services/webhookDispatcher.js";
import { WebhookHandlerError } from "../src/effect/errors.js";

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
  maxAskFinalizeRounds: 6,
  maxReviewPublishAttempts: 3,
  reviewConcurrency: 2,
  askConcurrency: 3,
  ackConcurrency: 2,
  queueRetryLimit: 3,
  queueRetryDelaySeconds: 30,
  queueRetryDelayMaxSeconds: 300,
  queueExpireInSeconds: 3600,
  queueHeartbeatSeconds: 60,
  queuePollingIntervalSeconds: 0.5,
  queueRetentionSeconds: 1209600,
  queueDeleteAfterSeconds: 604800,
  installationGroupConcurrency: 2,
  maxAskToolRounds: 12,
  webhookTimeoutMs: 10000,
  context7ApiKey: "",
  enableReviewLabelsEffort: true,
  enableReviewLabelsSecurity: false,
  maxPrFilesListed: 300,
  maxPrFilesPatchBytes: 500000,
  logLevel: "error",
};

function sign(body: Buffer): string {
  return `sha256=${crypto.createHmac("sha256", cfg.webhookSecret).update(body).digest("hex")}`;
}

function withIntake<R, E, A>(
  effect: Effect.Effect<A, E, R | WebhookDispatcher | IntakeLogger>,
  dispatcherLayer: Layer.Layer<WebhookDispatcher>,
) {
  const intakeLog = evlog.createOperationLogger({ method: "POST", path: "/webhooks" });
  return effect.pipe(
    Effect.provide(dispatcherLayer),
    Effect.provideService(IntakeLogger, intakeLog),
  );
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
      withIntake(
        processWebhookHttpRequestEffect(cfg, {
          method: "GET",
          url: "/health",
          headers: {},
          rawBody: Buffer.alloc(0),
        }),
        stubDispatcherLayer,
      ),
    );

    expect(out).toEqual({ status: 200, body: "ok", contentType: "text/plain; charset=utf-8" });
  });

  it("returns invalid signature", async () => {
    const body = Buffer.from("{}");
    const out = await Effect.runPromise(
      withIntake(
        processWebhookHttpRequestEffect(cfg, {
          method: "POST",
          url: "/webhooks",
          headers: { "x-hub-signature-256": "sha256=bad" },
          rawBody: body,
        }),
        stubDispatcherLayer,
      ),
    );

    expect(out).toEqual({ status: 401, body: "invalid signature" });
  });

  it("returns ok for valid webhook", async () => {
    const body = Buffer.from(JSON.stringify({ installation: { id: 1 } }));
    const out = await Effect.runPromise(
      withIntake(
        processWebhookHttpRequestEffect(cfg, {
          method: "POST",
          url: "/webhooks",
          headers: { "x-hub-signature-256": sign(body), "x-github-event": "ping" },
          rawBody: body,
        }),
        stubDispatcherLayer,
      ),
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

    const recordSpy = vi.spyOn(evlog, "recordEvent").mockImplementation(() => {});
    const tightCfg: Config = { ...cfg, webhookTimeoutMs: 1 };
    const body = Buffer.from(JSON.stringify({ installation: { id: 1 } }));

    try {
      await Effect.runPromise(
        withIntake(
          processWebhookHttpRequestEffect(tightCfg, {
            method: "POST",
            url: "/webhooks",
            headers: { "x-hub-signature-256": sign(body), "x-github-event": "ping" },
            rawBody: body,
          }),
          slowDispatcherLayer,
        ),
      );

      const budgetWarn = recordSpy.mock.calls.find(
        (c) => c[1] === "webhook_timeout_budget_exceeded",
      );
      expect(budgetWarn).toBeDefined();
      expect(budgetWarn?.[2]).toMatchObject({ budgetMs: 1 });
    } finally {
      recordSpy.mockRestore();
    }
  });

  it("returns 503 when dispatcher fails with WebhookHandlerError", async () => {
    const failingDispatcherLayer = Layer.succeed(
      WebhookDispatcher,
      WebhookDispatcher.of({
        dispatch: () =>
          Effect.fail(new WebhookHandlerError({ cause: new Error("boom"), message: "boom" })),
      }),
    );

    const recordSpy = vi.spyOn(evlog, "recordEvent").mockImplementation(() => {});
    const body = Buffer.from(JSON.stringify({ installation: { id: 1 } }));

    try {
      const out = await Effect.runPromise(
        withIntake(
          processWebhookHttpRequestEffect(cfg, {
            method: "POST",
            url: "/webhooks",
            headers: { "x-hub-signature-256": sign(body), "x-github-event": "ping" },
            rawBody: body,
          }),
          failingDispatcherLayer,
        ),
      );

      expect(out).toEqual({ status: 503, body: "service unavailable" });
      const errLog = recordSpy.mock.calls.find((c) => c[1] === "webhook_handler_error");
      expect(errLog).toBeDefined();
      expect(errLog?.[2]).toMatchObject({ message: "boom" });
    } finally {
      recordSpy.mockRestore();
    }
  });

  it("returns 200 before slow emitOperationLogger settles", async () => {
    let releaseEmit!: () => void;
    const emitGate = new Promise<void>((resolve) => {
      releaseEmit = resolve;
    });
    const emitSpy = vi.spyOn(evlog, "emitOperationLogger").mockImplementation(async () => {
      await emitGate;
    });
    const body = Buffer.from(JSON.stringify({ installation: { id: 1 } }));

    try {
      const order: string[] = [];
      const responsePromise = Effect.runPromise(
        withIntake(
          processWebhookHttpRequestEffect(cfg, {
            method: "POST",
            url: "/webhooks",
            headers: { "x-hub-signature-256": sign(body), "x-github-event": "ping" },
            rawBody: body,
          }),
          stubDispatcherLayer,
        ),
      ).then((response) => {
        order.push("response");
        return response;
      });

      await Promise.resolve();
      const out = await responsePromise;
      expect(out).toEqual({ status: 200, body: "ok" });
      expect(order).toEqual(["response"]);
      expect(emitSpy).toHaveBeenCalledTimes(1);

      releaseEmit();
      await Promise.resolve();
    } finally {
      emitSpy.mockRestore();
    }
  });
});
