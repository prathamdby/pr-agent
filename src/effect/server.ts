import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { createServer } from "node:http";
import type http from "node:http";
import type { Config } from "../config.js";
import { processWebhookHttpRequestEffect } from "./programs/processWebhookRequestEffect.js";
import { WebhookDispatcherLive } from "./services/webhookDispatcher.js";

/**
 * Defensive header normalization. `@effect/platform-node`'s `ServerRequestImpl.headers`
 * passes through Node's `IncomingMessage.headers` (typed `string | string[] | undefined`
 * by @types/node) without coercion. At runtime, Node coalesces non-multi-value headers to
 * a single comma-joined string — verified empirically — but normalize defensively to make
 * the contract explicit and avoid relying on undocumented runtime behavior.
 */
function singleHeader(v: string | readonly string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v.join(", ") : (v as string);
}

export function buildEffectWebhookApp(cfg: Config) {
  return HttpRouter.empty.pipe(
    HttpRouter.all(
      "*",
      Effect.gen(function* () {
        const req = yield* HttpServerRequest.HttpServerRequest;
        const rawBody = Buffer.from(yield* req.arrayBuffer);
        const result = yield* processWebhookHttpRequestEffect(cfg, {
          method: req.method,
          url: req.url,
          headers: {
            "x-hub-signature-256": singleHeader(req.headers["x-hub-signature-256"]),
            "x-github-event": singleHeader(req.headers["x-github-event"]),
            "x-github-delivery": singleHeader(req.headers["x-github-delivery"]),
          },
          rawBody,
        });

        return HttpServerResponse.text(result.body, {
          status: result.status,
          contentType: result.contentType,
        });
      }),
    ),
  );
}

export function buildEffectWebhookLayer(cfg: Config, serverFactory: () => http.Server = createServer) {
  const serverLayer = NodeHttpServer.layer(serverFactory, { port: cfg.port });
  return buildEffectWebhookApp(cfg).pipe(
    HttpServer.serve(),
    Layer.provide(serverLayer),
    Layer.provide(WebhookDispatcherLive),
  );
}

export function startEffectWebhookServer(cfg: Config): void {
  NodeRuntime.runMain(Layer.launch(buildEffectWebhookLayer(cfg)));
}
