import { Effect } from "effect";
import type { Config } from "../../config.js";
import { emitOperationLogger, recordEvent } from "../../evlog.js";
import { verifyGithubWebhookSignature } from "../../webhook/verifySignature.js";
import { IntakeLogger } from "../intakeLogger.js";
import { WebhookHandlerError } from "../errors.js";
import { WebhookDispatcher } from "../services/webhookDispatcher.js";

export type WebhookRequestLike = {
  method: string;
  url: string;
  headers: Record<string, string | undefined>;
  rawBody: Buffer;
};

export type WebhookResponseLike = {
  status: number;
  body: string;
  contentType?: string;
};

function requestPath(url: string): string {
  return url.split("?")[0] ?? "";
}

export function processWebhookHttpRequestEffect(
  cfg: Config,
  req: WebhookRequestLike,
): Effect.Effect<WebhookResponseLike, never, WebhookDispatcher | IntakeLogger> {
  return Effect.gen(function* () {
    const intakeLog = yield* IntakeLogger;
    const dispatcher = yield* WebhookDispatcher;
    const path = requestPath(req.url);
    const delivery = req.headers["x-github-delivery"];
    const githubEvent = req.headers["x-github-event"] ?? "";
    const logDelivery = delivery ?? "(missing)";

    intakeLog.set({
      github: { event: githubEvent, delivery: logDelivery },
      webhook: { method: req.method, path },
      runtime: "effect",
    });

    if (req.method === "GET" && path === "/health") {
      const response = { status: 200, body: "ok", contentType: "text/plain; charset=utf-8" } satisfies WebhookResponseLike;
      recordEvent(intakeLog, "health_check", { status: response.status });
      intakeLog.set({ webhook: { status: response.status } });
      yield* Effect.promise(() => emitOperationLogger(intakeLog, { event: "health_check" }));
      return response;
    }

    if (req.method !== "POST" || path !== "/webhooks") {
      const response = { status: 404, body: "" } satisfies WebhookResponseLike;
      recordEvent(intakeLog, "route_not_found", { status: response.status });
      intakeLog.set({ webhook: { status: response.status } });
      yield* Effect.promise(() => emitOperationLogger(intakeLog, { event: "route_not_found" }));
      return response;
    }

    const sig = req.headers["x-hub-signature-256"];
    if (!verifyGithubWebhookSignature(cfg.webhookSecret, req.rawBody, sig)) {
      recordEvent(intakeLog, "invalid_signature");
      const response = { status: 401, body: "invalid signature" } satisfies WebhookResponseLike;
      intakeLog.set({ webhook: { status: response.status, signatureInvalid: true } });
      yield* Effect.promise(() => emitOperationLogger(intakeLog, { event: "invalid_signature" }));
      return response;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(req.rawBody.toString("utf8")) as Record<string, unknown>;
    } catch {
      recordEvent(intakeLog, "invalid_json");
      const response = { status: 400, body: "invalid json" } satisfies WebhookResponseLike;
      intakeLog.set({ webhook: { status: response.status } });
      yield* Effect.promise(() => emitOperationLogger(intakeLog, { event: "invalid_json" }));
      return response;
    }

    const t0 = Date.now();
    const result = yield* dispatcher
      .dispatch({
        cfg,
        headers: { delivery, event: githubEvent, rawBody: req.rawBody },
        payload,
      })
      .pipe(
        Effect.map(() => ({ ok: true as const })),
        Effect.catchTag("WebhookHandlerError", (err: WebhookHandlerError) =>
          Effect.sync(() => {
            recordEvent(intakeLog, "webhook_handler_error", {
              event: githubEvent,
              delivery: logDelivery,
              message: err.message,
            });
            return { ok: false as const };
          }),
        ),
      );
    const elapsedMs = Date.now() - t0;

    if (!result.ok) {
      const response = { status: 503, body: "service unavailable" } satisfies WebhookResponseLike;
      intakeLog.set({ webhook: { status: response.status, elapsedMs, handlerFailed: true } });
      yield* Effect.promise(() => emitOperationLogger(intakeLog, { event: "webhook_handler_error" }));
      return response;
    }

    recordEvent(intakeLog, "webhook_handled", { event: githubEvent, delivery: logDelivery, ms: elapsedMs });
    intakeLog.set({
      webhook: {
        status: 200,
        elapsedMs,
        budgetExceeded: elapsedMs > cfg.webhookTimeoutMs,
        budgetMs: cfg.webhookTimeoutMs,
      },
    });
    if (elapsedMs > cfg.webhookTimeoutMs) {
      recordEvent(intakeLog, "webhook_timeout_budget_exceeded", {
        event: githubEvent,
        delivery: logDelivery,
        ms: elapsedMs,
        budgetMs: cfg.webhookTimeoutMs,
      });
    }
    yield* Effect.promise(() => emitOperationLogger(intakeLog, { event: "webhook_handled" }));
    return { status: 200, body: "ok" } satisfies WebhookResponseLike;
  });
}
