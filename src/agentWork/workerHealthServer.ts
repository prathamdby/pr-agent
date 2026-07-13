import http from "node:http";
import type { WorkerReadinessResult } from "./workerReadiness.js";

export type WorkerHealthServer = {
  readonly server: http.Server;
  readonly close: () => Promise<void>;
};

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port);
  });
}

/**
 * Minimal liveness/readiness HTTP surface for ROLE=worker.
 * Distinct from web `/ready` (Postgres-only for webhook intake).
 */
export async function startWorkerHealthServer(params: {
  readonly port: number;
  readonly evaluateReady: () => Promise<WorkerReadinessResult>;
}): Promise<WorkerHealthServer> {
  const server = http.createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? "").split("?")[0] ?? "";
      if (req.method === "GET" && path === "/health") {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end("ok");
        return;
      }
      if (req.method === "GET" && path === "/ready") {
        const result = await params.evaluateReady();
        res.writeHead(result.ready ? 200 : 503, {
          "content-type": "text/plain; charset=utf-8",
        });
        res.end(result.ready ? "ready" : "not ready");
        return;
      }
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("");
    })().catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      }
      res.end("error");
    });
  });

  await listen(server, params.port);

  return {
    server,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
