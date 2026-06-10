import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import crypto from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Config } from "../config.js";
import { createOperationLogger } from "../evlog.js";
import { IntakeLogger } from "./intakeLogger.js";
import { processWebhookHttpRequestEffect } from "./programs/processWebhookRequestEffect.js";
import { WebhookDispatcher, buildWebhookDispatcherLive } from "./services/webhookDispatcher.js";

function singleHeader(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v.join(", ") : v;
}

function requestPath(url: string): string {
  return url.split("?")[0] ?? url;
}

function buildEffectWebhookApp(cfg: Config) {
  return HttpRouter.empty.pipe(
    HttpRouter.all(
      "*",
      Effect.gen(function* () {
        const req = yield* HttpServerRequest.HttpServerRequest;
        const path = requestPath(req.url);

        if (req.method === "GET" && path === "/health") {
          return HttpServerResponse.text("ok", {
            status: 200,
            contentType: "text/plain; charset=utf-8",
          });
        }

        if (req.method === "GET" && path === "/ready") {
          const dispatcher = yield* WebhookDispatcher;
          const ready = yield* dispatcher.ping();
          return HttpServerResponse.text(ready ? "ready" : "not ready", {
            status: ready ? 200 : 503,
            contentType: "text/plain; charset=utf-8",
          });
        }

        const rawBody = Buffer.from(yield* req.arrayBuffer);
        const intakeLog = createOperationLogger({
          method: req.method,
          path,
          requestId: singleHeader(req.headers["x-github-delivery"]) ?? crypto.randomUUID(),
          context: { role: "web" },
        });

        const result = yield* processWebhookHttpRequestEffect(cfg, {
          method: req.method,
          url: req.url,
          headers: {
            "x-hub-signature-256": singleHeader(req.headers["x-hub-signature-256"]),
            "x-github-event": singleHeader(req.headers["x-github-event"]),
            "x-github-delivery": singleHeader(req.headers["x-github-delivery"]),
          },
          rawBody,
        }).pipe(Effect.provideService(IntakeLogger, intakeLog));

        return HttpServerResponse.text(result.body, {
          status: result.status,
          contentType: result.contentType,
        });
      }),
    ),
  );
}

export function buildEffectWebhookLayer(
  cfg: Config,
  serverFactory: () => Server = createServer,
  dispatcherLayer: Layer.Layer<WebhookDispatcher, Error> = buildWebhookDispatcherLive(cfg),
) {
  const serverLayer = NodeHttpServer.layer(serverFactory, { port: cfg.port });
  return buildEffectWebhookApp(cfg).pipe(
    HttpServer.serve(),
    Layer.provide(serverLayer),
    Layer.provide(dispatcherLayer),
  );
}

export function startEffectWebhookServer(cfg: Config): void {
  NodeRuntime.runMain(Layer.launch(buildEffectWebhookLayer(cfg)));
}
