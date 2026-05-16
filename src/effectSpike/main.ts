import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { createServer } from "node:http";
import { verifyGithubWebhookSignature } from "../webhook/verifySignature.js";

const port = Number(process.env.PORT ?? "7224");
const secret = process.env.WEBHOOK_SECRET ?? "dev-secret";

const router = HttpRouter.empty.pipe(
  HttpRouter.get("/health", HttpServerResponse.text("ok")),
  HttpRouter.post(
    "/webhooks",
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      const raw = Buffer.from(yield* req.arrayBuffer);
      const sig = req.headers["x-hub-signature-256"];
      const sigHeader = Array.isArray(sig) ? sig[0] : sig;

      if (!verifyGithubWebhookSignature(secret, raw, sigHeader)) {
        return HttpServerResponse.text("invalid signature", { status: 401 });
      }

      try {
        JSON.parse(raw.toString("utf8"));
      } catch {
        return HttpServerResponse.text("invalid json", { status: 400 });
      }

      return HttpServerResponse.text("ok", { status: 200 });
    }),
  ),
);

const ServerLive = NodeHttpServer.layer(() => createServer(), { port });
const HttpLive = router.pipe(HttpServer.serve(), Layer.provide(ServerLive));

NodeRuntime.runMain(Layer.launch(HttpLive));
