import { Effect } from "effect";
import type { Config } from "../../config.js";
import { log } from "../../log.js";
import { verifyGithubWebhookSignature } from "../../webhook/verifySignature.js";
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
): Effect.Effect<WebhookResponseLike, never, WebhookDispatcher> {
  return Effect.gen(function* () {
    const dispatcher = yield* WebhookDispatcher;
    const path = requestPath(req.url);

    if (req.method === "GET" && path === "/health") {
      return { status: 200, body: "ok", contentType: "text/plain; charset=utf-8" } satisfies WebhookResponseLike;
    }

    if (req.method !== "POST" || path !== "/webhooks") {
      return { status: 404, body: "" } satisfies WebhookResponseLike;
    }

    const sig = req.headers["x-hub-signature-256"];
    if (!verifyGithubWebhookSignature(cfg.webhookSecret, req.rawBody, sig)) {
      log.warn("invalid_signature");
      return { status: 401, body: "invalid signature" } satisfies WebhookResponseLike;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(req.rawBody.toString("utf8")) as Record<string, unknown>;
    } catch {
      return { status: 400, body: "invalid json" } satisfies WebhookResponseLike;
    }

    const event = req.headers["x-github-event"] ?? "";
    const delivery = req.headers["x-github-delivery"];
    const logDelivery = delivery ?? "(missing)";

    const t0 = Date.now();
    const result = yield* dispatcher
      .dispatch({
        cfg,
        headers: { delivery, event, rawBody: req.rawBody },
        payload,
      })
      .pipe(
        Effect.map(() => ({ ok: true as const })),
        Effect.catchTag("WebhookHandlerError", (err: WebhookHandlerError) =>
          Effect.sync(() => {
            log.error("webhook_handler_error", { event, delivery: logDelivery, message: err.message });
            return { ok: false as const };
          }),
        ),
      );
    const elapsedMs = Date.now() - t0;

    if (!result.ok) {
      return { status: 500, body: "internal error" } satisfies WebhookResponseLike;
    }

    log.info("webhook_handled", { event, delivery: logDelivery, ms: elapsedMs, runtime: "effect" });
    if (elapsedMs > cfg.webhookTimeoutMs) {
      log.warn("webhook_timeout_budget_exceeded", {
        event,
        delivery: logDelivery,
        ms: elapsedMs,
        budgetMs: cfg.webhookTimeoutMs,
      });
    }

    return { status: 200, body: "ok" } satisfies WebhookResponseLike;
  });
}
