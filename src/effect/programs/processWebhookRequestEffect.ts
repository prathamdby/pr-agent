import { Duration, Effect } from "effect";
import type { Config } from "../../config.js";
import { emitOperationLogger, recordEvent } from "../../evlog.js";
import { GITHUB_WEBHOOK_RESPONSE_MARGIN_MS } from "../../settings/index.js";
import { verifyGithubWebhookSignature } from "../../webhook/verifySignature.js";
import { IntakeLogger } from "../intakeLogger.js";
import { WebhookHandlerError } from "../errors.js";
import { WebhookDispatcher } from "../services/webhookDispatcher.js";

type DispatchResult =
  | { readonly kind: "ok" }
  | { readonly kind: "failed" }
  | { readonly kind: "timeout" };

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
  const path = requestPath(req.url);

  if (req.method === "GET" && path === "/health") {
    return Effect.succeed({
      status: 200,
      body: "ok",
      contentType: "text/plain; charset=utf-8",
    } satisfies WebhookResponseLike);
  }

  if (req.method === "GET" && path === "/ready") {
    return Effect.gen(function* () {
      const dispatcher = yield* WebhookDispatcher;
      const ready = yield* dispatcher.ping();
      return {
        status: ready ? 200 : 503,
        body: ready ? "ready" : "not ready",
        contentType: "text/plain; charset=utf-8",
      } satisfies WebhookResponseLike;
    });
  }

  return Effect.gen(function* () {
    const intakeLog = yield* IntakeLogger;
    const dispatcher = yield* WebhookDispatcher;
    const delivery = req.headers["x-github-delivery"];
    const githubEvent = req.headers["x-github-event"] ?? "";
    const logDelivery = delivery ?? "(missing)";

    intakeLog.set({
      github: { event: githubEvent, delivery: logDelivery },
      webhook: { method: req.method, path },
      runtime: "effect",
    });

    if (req.method !== "POST" || path !== "/webhooks") {
      const response = { status: 404, body: "" } satisfies WebhookResponseLike;
      recordEvent(intakeLog, "route_not_found", { status: response.status }, "debug");
      intakeLog.set({ webhook: { status: response.status } });
      yield* Effect.promise(() => emitOperationLogger(intakeLog, { event: "route_not_found" }));
      return response;
    }

    const sig = req.headers["x-hub-signature-256"];
    if (!verifyGithubWebhookSignature(cfg.webhookSecret, req.rawBody, sig)) {
      recordEvent(intakeLog, "invalid_signature", undefined, "warn");
      const response = {
        status: 401,
        body: "invalid signature",
      } satisfies WebhookResponseLike;
      intakeLog.set({
        webhook: { status: response.status, signatureInvalid: true },
      });
      yield* Effect.promise(() => emitOperationLogger(intakeLog, { event: "invalid_signature" }));
      return response;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(req.rawBody.toString("utf8")) as Record<string, unknown>;
    } catch {
      recordEvent(intakeLog, "invalid_json", undefined, "warn");
      const response = {
        status: 400,
        body: "invalid json",
      } satisfies WebhookResponseLike;
      intakeLog.set({ webhook: { status: response.status } });
      yield* Effect.promise(() => emitOperationLogger(intakeLog, { event: "invalid_json" }));
      return response;
    }

    const t0 = Date.now();
    const responseBudgetMs = Math.max(1, cfg.webhookTimeoutMs - GITHUB_WEBHOOK_RESPONSE_MARGIN_MS);
    const result: DispatchResult = yield* dispatcher
      .dispatch({
        cfg,
        headers: { delivery, event: githubEvent, rawBody: req.rawBody },
        payload,
      })
      .pipe(
        Effect.timeout(Duration.millis(responseBudgetMs)),
        Effect.map(() => ({ kind: "ok" as const })),
        Effect.catchTag("TimeoutException", () =>
          Effect.sync(() => {
            recordEvent(
              intakeLog,
              "webhook_timeout_budget_exceeded",
              {
                event: githubEvent,
                delivery: logDelivery,
                budgetMs: cfg.webhookTimeoutMs,
                responseBudgetMs,
              },
              "warn",
            );
            return { kind: "timeout" as const };
          }),
        ),
        Effect.catchTag("WebhookHandlerError", (err: WebhookHandlerError) =>
          Effect.sync(() => {
            recordEvent(
              intakeLog,
              "webhook_handler_error",
              {
                event: githubEvent,
                delivery: logDelivery,
                message: err.message,
              },
              "error",
            );
            return { kind: "failed" as const };
          }),
        ),
      );
    const elapsedMs = Date.now() - t0;

    if (result.kind !== "ok") {
      const response = {
        status: 503,
        body: "service unavailable",
      } satisfies WebhookResponseLike;
      intakeLog.set({
        webhook: {
          status: response.status,
          elapsedMs,
          handlerFailed: result.kind === "failed",
          timeout: result.kind === "timeout",
          responseBudgetMs,
        },
      });
      yield* Effect.promise(() =>
        emitOperationLogger(intakeLog, {
          event:
            result.kind === "timeout" ? "webhook_timeout_budget_exceeded" : "webhook_handler_error",
        }),
      );
      return response;
    }

    recordEvent(
      intakeLog,
      "webhook_handled",
      { event: githubEvent, delivery: logDelivery, ms: elapsedMs },
      "info",
    );
    intakeLog.set({
      webhook: {
        status: 200,
        elapsedMs,
        budgetExceeded: elapsedMs > cfg.webhookTimeoutMs,
        budgetMs: cfg.webhookTimeoutMs,
        responseBudgetMs,
      },
    });
    if (elapsedMs > cfg.webhookTimeoutMs) {
      recordEvent(
        intakeLog,
        "webhook_timeout_budget_exceeded",
        {
          event: githubEvent,
          delivery: logDelivery,
          ms: elapsedMs,
          budgetMs: cfg.webhookTimeoutMs,
        },
        "warn",
      );
    }
    void emitOperationLogger(intakeLog, { event: "webhook_handled" }).catch(() => undefined);
    return { status: 200, body: "ok" } satisfies WebhookResponseLike;
  }).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        const intakeLog = yield* IntakeLogger;
        if (intakeLog.getContext().emitted === true) return;
        const webhook = intakeLog.getContext().webhook as { status?: number } | undefined;
        if (webhook?.status === 200) return;
        const lastEvent = intakeLog.getContext().lastEvent;
        yield* Effect.promise(() =>
          emitOperationLogger(intakeLog, {
            event: typeof lastEvent === "string" ? lastEvent : "webhook_request_aborted",
          }),
        ).pipe(Effect.catchAll(() => Effect.void));
      }),
    ),
  );
}
