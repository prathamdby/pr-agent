import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { NodeHttpServer, NodeHttpServerRequest, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import crypto from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
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

type BodyReadResult =
  | { readonly kind: "ok"; readonly rawBody: Buffer }
  | { readonly kind: "too_large" };

const BODY_TOO_LARGE = { kind: "too_large" } satisfies BodyReadResult;

function parseContentLength(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function readRawBody(
  req: HttpServerRequest.HttpServerRequest,
  maxBodyBytes: number,
): Effect.Effect<BodyReadResult, unknown> {
  const contentLength = parseContentLength(singleHeader(req.headers["content-length"]));
  if (contentLength !== undefined && contentLength > maxBodyBytes) {
    return Effect.succeed(BODY_TOO_LARGE);
  }

  return Effect.tryPromise(() =>
    readNodeRawBody(NodeHttpServerRequest.toIncomingMessage(req), maxBodyBytes),
  );
}

function readNodeRawBody(req: IncomingMessage, maxBodyBytes: number): Promise<BodyReadResult> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    function cleanup() {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    }

    function settle(result: BodyReadResult) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    }

    function onData(chunk: Buffer | string) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > maxBodyBytes) {
        req.destroy();
        settle(BODY_TOO_LARGE);
        return;
      }
      chunks.push(buffer);
    }

    function onEnd() {
      settle({ kind: "ok", rawBody: Buffer.concat(chunks) });
    }

    function onError(error: Error) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }

    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
  });
}

function payloadTooLargeResponse() {
  return HttpServerResponse.text("payload too large", {
    status: 413,
    contentType: "text/plain; charset=utf-8",
  });
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

        if (req.method !== "POST" || path !== "/webhooks") {
          return HttpServerResponse.text("", { status: 404 });
        }

        const body = yield* readRawBody(req, cfg.webhookMaxBodyBytes);
        if (body.kind === "too_large") {
          return payloadTooLargeResponse();
        }

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
          rawBody: body.rawBody,
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
