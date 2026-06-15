import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Effect, Fiber, Layer } from "effect";
import type { Config } from "../src/config.js";
import { initEvlog } from "../src/evlog.js";
import { buildEffectWebhookLayer } from "../src/effect/server.js";
import { AgentWorkScheduler } from "../src/agentWork/scheduler.js";
import { WebhookHandlers } from "../src/effect/services/webhookHandlers.js";
import { makeTestConfig } from "./helpers/config.js";

const testCfg = makeTestConfig({
  webhookSecret: "secret",
  maxAskFinalizeRounds: 6,
  enableReviewLabelsEffort: false,
});

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ hostname: "127.0.0.1", port, path }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(Buffer.from(c)));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      })
      .on("error", reject);
  });
}

function postSigned(
  port: number,
  path: string,
  body: Buffer,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": body.length,
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(Buffer.from(c)));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

function postChunked(
  port: number,
  path: string,
  chunks: readonly Buffer[],
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const responseChunks: Buffer[] = [];
    const resolveResponse = () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(responseChunks).toString("utf8");
      const sep = text.indexOf("\r\n\r\n");
      if (sep < 0) {
        reject(new Error("chunked response ended before headers"));
        return;
      }
      const head = text.slice(0, sep);
      const body = text.slice(sep + 4);
      const statusLine = head.split("\r\n")[0] ?? "";
      const status = Number(statusLine.split(" ")[1] ?? 0);
      resolve({ status, body });
    };
    const rejectIfNoResponse = (error: Error) => {
      if (settled) return;
      if (responseChunks.length > 0) {
        resolveResponse();
        return;
      }
      settled = true;
      reject(error);
    };
    const sock = net.createConnection({ host: "127.0.0.1", port }, () => {
      const headerLines = Object.entries({
        "Content-Type": "application/json",
        "Transfer-Encoding": "chunked",
        ...headers,
      }).map(([name, value]) => `${name}: ${value}`);
      const reqHead = [
        `POST ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        ...headerLines,
        "Connection: close",
        "",
        "",
      ].join("\r\n");
      const chunkFrames = chunks.flatMap((chunk) => [
        Buffer.from(`${chunk.length.toString(16)}\r\n`),
        chunk,
        Buffer.from("\r\n"),
      ]);
      sock.end(Buffer.concat([Buffer.from(reqHead), ...chunkFrames, Buffer.from("0\r\n\r\n")]));
    });
    sock.on("data", (c) => responseChunks.push(Buffer.from(c)));
    sock.on("end", resolveResponse);
    sock.on("close", () => {
      if (settled) return;
      if (responseChunks.length > 0) {
        resolveResponse();
        return;
      }
      settled = true;
      reject(new Error("chunked socket closed before response"));
    });
    sock.on("error", rejectIfNoResponse);
  });
}

function postRaw(
  port: number,
  path: string,
  body: Buffer,
  headers: string[],
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: "127.0.0.1", port }, () => {
      const headerLines = [];
      for (let i = 0; i < headers.length; i += 2) {
        headerLines.push(`${headers[i]}: ${headers[i + 1]}`);
      }
      const req = [
        `POST ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        `Content-Type: application/json`,
        `Content-Length: ${body.length}`,
        ...headerLines,
        "Connection: close",
        "",
        "",
      ].join("\r\n");
      sock.write(req);
      sock.write(body);
    });

    const chunks: Buffer[] = [];
    sock.on("data", (c) => chunks.push(Buffer.from(c)));
    sock.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const sep = text.indexOf("\r\n\r\n");
      const head = text.slice(0, sep);
      const respBody = text.slice(sep + 4);
      const statusLine = head.split("\r\n")[0] ?? "";
      const status = Number(statusLine.split(" ")[1] ?? 0);
      resolve({ status, body: respBody });
    });
    sock.on("error", reject);
  });
}

function signBody(secret: string, body: Buffer): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

type Handle = { server: http.Server; fiber: Fiber.RuntimeFiber<void, unknown> };

function startEffectServer({
  pingResult = true,
  cfg = testCfg,
  onDispatch = () => Effect.void,
}: {
  readonly pingResult?: boolean;
  readonly cfg?: Config;
  readonly onDispatch?: () => Effect.Effect<void>;
} = {}): Promise<Handle> {
  return new Promise((resolve, reject) => {
    let captured: http.Server | undefined;
    const intakeLayer = Layer.mergeAll(
      Layer.succeed(
        AgentWorkScheduler,
        AgentWorkScheduler.of({
          recordIgnored: () => onDispatch(),
          submitAutomatedReview: () => onDispatch(),
          submitSlashCommand: () => onDispatch(),
          matchesStoredInlineReview: () => Effect.succeed(false),
          ping: () => Effect.succeed(pingResult),
        }),
      ),
      Layer.succeed(
        WebhookHandlers,
        WebhookHandlers.of({
          pullRequest: () => onDispatch(),
          issueComment: () => onDispatch(),
          pullRequestReviewComment: () => onDispatch(),
        }),
      ),
    );
    const layer = buildEffectWebhookLayer(
      cfg,
      () => {
        captured = http.createServer();
        captured.once("listening", () => {
          if (captured) resolve({ server: captured, fiber });
        });
        captured.once("error", reject);
        return captured;
      },
      intakeLayer,
    );
    const fiber = Effect.runFork(Layer.launch(layer));
  });
}

async function stopEffectServer(handle: Handle): Promise<void> {
  await Effect.runPromise(Fiber.interrupt(handle.fiber));
  if (handle.server.listening) {
    await new Promise<void>((resolve) => handle.server.close(() => resolve()));
  }
}

describe("effect webhook server (end-to-end)", () => {
  beforeAll(() => {
    initEvlog("error", { silent: true });
  });

  let handle: Handle | undefined;

  afterEach(async () => {
    if (!handle) return;
    await stopEffectServer(handle);
    handle = undefined;
  });

  it("returns 200 plain ok for GET /health", async () => {
    handle = await startEffectServer();
    const addr = handle.server.address();
    if (typeof addr !== "object" || !addr?.port) throw new Error("no port");
    const res = await get(addr.port, "/health");
    expect(res.status).toBe(200);
    expect(res.body).toBe("ok");
  });

  it("returns 200 ready for GET /ready when the DB ping succeeds", async () => {
    handle = await startEffectServer({ pingResult: true });
    const addr = handle.server.address();
    if (typeof addr !== "object" || !addr?.port) throw new Error("no port");
    const res = await get(addr.port, "/ready");
    expect(res.status).toBe(200);
    expect(res.body).toBe("ready");
  });

  it("returns 503 not ready for GET /ready when the DB ping fails", async () => {
    handle = await startEffectServer({ pingResult: false });
    const addr = handle.server.address();
    if (typeof addr !== "object" || !addr?.port) throw new Error("no port");
    const res = await get(addr.port, "/ready");
    expect(res.status).toBe(503);
    expect(res.body).toBe("not ready");
  });

  it("returns 404 for unknown GET path", async () => {
    handle = await startEffectServer();
    const addr = handle.server.address();
    if (typeof addr !== "object" || !addr?.port) throw new Error("no port");
    const res = await get(addr.port, "/nope");
    expect(res.status).toBe(404);
  });

  it("accepts a signed ping webhook end-to-end and returns 200 ok", async () => {
    handle = await startEffectServer();
    const addr = handle.server.address();
    if (typeof addr !== "object" || !addr?.port) throw new Error("no port");

    const body = Buffer.from(JSON.stringify({ zen: "smoke", installation: { id: 1 } }));
    const res = await postSigned(addr.port, "/webhooks", body, {
      "x-hub-signature-256": signBody(testCfg.webhookSecret, body),
      "x-github-event": "ping",
      "x-github-delivery": "e2e-ping-1",
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe("ok");
  });

  it("rejects an unsigned POST with 401 end-to-end", async () => {
    handle = await startEffectServer();
    const addr = handle.server.address();
    if (typeof addr !== "object" || !addr?.port) throw new Error("no port");

    const body = Buffer.from(JSON.stringify({ zen: "no-sig" }));
    const res = await postSigned(addr.port, "/webhooks", body, {});
    expect(res.status).toBe(401);
    expect(res.body).toBe("invalid signature");
  });

  it("rejects bodies over the configured Content-Length before signature checks", async () => {
    let dispatchCalls = 0;
    handle = await startEffectServer({
      cfg: makeTestConfig({ webhookMaxBodyBytes: 8 }),
      onDispatch: () =>
        Effect.sync(() => {
          dispatchCalls += 1;
        }),
    });
    const addr = handle.server.address();
    if (typeof addr !== "object" || !addr?.port) throw new Error("no port");

    const body = Buffer.from(JSON.stringify({ zen: "too large" }));
    const res = await postSigned(addr.port, "/webhooks", body, {
      "x-hub-signature-256": "sha256=bad",
      "x-github-event": "ping",
      "x-github-delivery": "too-large-content-length",
    });
    expect(res.status).toBe(413);
    expect(res.body).toBe("payload too large");
    expect(dispatchCalls).toBe(0);
  });

  it("closes chunked bodies over the configured limit while reading", async () => {
    let dispatchCalls = 0;
    const destroySpy = vi.spyOn(http.IncomingMessage.prototype, "destroy");
    handle = await startEffectServer({
      cfg: makeTestConfig({ webhookMaxBodyBytes: 8 }),
      onDispatch: () =>
        Effect.sync(() => {
          dispatchCalls += 1;
        }),
    });
    try {
      const addr = handle.server.address();
      if (typeof addr !== "object" || !addr?.port) throw new Error("no port");

      await expect(
        postChunked(addr.port, "/webhooks", [Buffer.from('{"zen":'), Buffer.from('"too large"}')], {
          "x-hub-signature-256": "sha256=bad",
          "x-github-event": "ping",
          "x-github-delivery": "too-large-chunked",
        }),
      ).rejects.toThrow("chunked response ended before headers");
      expect(dispatchCalls).toBe(0);
      expect(destroySpy).toHaveBeenCalled();
    } finally {
      destroySpy.mockRestore();
    }
  });

  it("handles duplicate x-hub-signature-256 headers gracefully (no crash; 401)", async () => {
    handle = await startEffectServer();
    const addr = handle.server.address();
    if (typeof addr !== "object" || !addr?.port) throw new Error("no port");

    const body = Buffer.from(JSON.stringify({ zen: "dup-headers" }));
    // Real sig under the correct secret + a second junk sig. @effect/platform's Headers
    // coalesces duplicates with `, ` so the verifier sees a garbage value and returns 401
    // without throwing on `.startsWith()`.
    const realSig = signBody(testCfg.webhookSecret, body);
    const res = await postRaw(addr.port, "/webhooks", body, [
      "x-hub-signature-256",
      realSig,
      "x-hub-signature-256",
      "sha256=deadbeef",
      "x-github-event",
      "ping",
      "x-github-delivery",
      "dup-1",
    ]);
    expect(res.status).toBe(401);
    expect(res.body).toBe("invalid signature");
  });
});
