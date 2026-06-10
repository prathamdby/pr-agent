import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Effect, Layer } from "effect";
import * as evlog from "../src/evlog.js";
import { IntakeLogger } from "../src/effect/intakeLogger.js";
import { processWebhookPostRequestEffect } from "../src/effect/programs/processWebhookRequestEffect.js";
import { WebhookDispatcher } from "../src/effect/services/webhookDispatcher.js";
import { WebhookHandlerError } from "../src/effect/errors.js";
import { makeTestConfig } from "./helpers/config.js";

const cfg = makeTestConfig({
  webhookSecret: "secret",
  maxAskFinalizeRounds: 6,
  askConcurrency: 3,
});

function sign(body: Buffer): string {
  return `sha256=${crypto.createHmac("sha256", cfg.webhookSecret).update(body).digest("hex")}`;
}

function withIntake<R, E, A>(
  effect: Effect.Effect<A, E, R | WebhookDispatcher | IntakeLogger>,
  dispatcherLayer: Layer.Layer<WebhookDispatcher>,
) {
  const intakeLog = evlog.createOperationLogger({
    method: "POST",
    path: "/webhooks",
  });
  return effect.pipe(
    Effect.provide(dispatcherLayer),
    Effect.provideService(IntakeLogger, intakeLog),
  );
}

describe("processWebhookPostRequestEffect", () => {
  const stubDispatcherLayer = Layer.succeed(
    WebhookDispatcher,
    WebhookDispatcher.of({
      dispatch: () => Effect.void,
      ping: () => Effect.succeed(true),
    }),
  );

  it("returns invalid signature", async () => {
    const body = Buffer.from("{}");
    const out = await Effect.runPromise(
      withIntake(
        processWebhookPostRequestEffect(cfg, {
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
        processWebhookPostRequestEffect(cfg, {
          headers: {
            "x-hub-signature-256": sign(body),
            "x-github-event": "ping",
          },
          rawBody: body,
        }),
        stubDispatcherLayer,
      ),
    );

    expect(out).toEqual({ status: 200, body: "ok" });
  });

  it("returns 503 when handling exceeds the timeout budget", async () => {
    const slowDispatcherLayer = Layer.succeed(
      WebhookDispatcher,
      WebhookDispatcher.of({
        dispatch: () => Effect.sleep("20 millis"),
        ping: () => Effect.succeed(true),
      }),
    );

    const recordSpy = vi.spyOn(evlog, "recordEvent").mockImplementation(() => {});
    const tightCfg = { ...cfg, webhookTimeoutMs: 1 };
    const body = Buffer.from(JSON.stringify({ installation: { id: 1 } }));

    try {
      const out = await Effect.runPromise(
        withIntake(
          processWebhookPostRequestEffect(tightCfg, {
            headers: {
              "x-hub-signature-256": sign(body),
              "x-github-event": "ping",
            },
            rawBody: body,
          }),
          slowDispatcherLayer,
        ),
      );

      expect(out).toEqual({ status: 503, body: "service unavailable" });
      const budgetWarn = recordSpy.mock.calls.find(
        (c) => c[1] === "webhook_timeout_budget_exceeded",
      );
      expect(budgetWarn).toBeDefined();
      expect(budgetWarn?.[2]).toMatchObject({ budgetMs: 1, responseBudgetMs: 1 });
    } finally {
      recordSpy.mockRestore();
    }
  });

  it("returns 503 when dispatcher fails with WebhookHandlerError", async () => {
    const failingDispatcherLayer = Layer.succeed(
      WebhookDispatcher,
      WebhookDispatcher.of({
        dispatch: () =>
          Effect.fail(
            new WebhookHandlerError({
              cause: new Error("boom"),
              message: "boom",
            }),
          ),
        ping: () => Effect.succeed(true),
      }),
    );

    const recordSpy = vi.spyOn(evlog, "recordEvent").mockImplementation(() => {});
    const body = Buffer.from(JSON.stringify({ installation: { id: 1 } }));

    try {
      const out = await Effect.runPromise(
        withIntake(
          processWebhookPostRequestEffect(cfg, {
            headers: {
              "x-hub-signature-256": sign(body),
              "x-github-event": "ping",
            },
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
          processWebhookPostRequestEffect(cfg, {
            headers: {
              "x-hub-signature-256": sign(body),
              "x-github-event": "ping",
            },
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
