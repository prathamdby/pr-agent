import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Effect, Fiber, Layer } from "effect";
import type { Config } from "../src/config.js";
import { initEvlog } from "../src/evlog.js";
import { buildEffectWebhookLayer } from "../src/effect/server.js";
import { WebhookDispatcher } from "../src/effect/services/webhookDispatcher.js";

const testCfg: Config = {
	port: 0,
	githubAppId: "1",
	githubAppPrivateKey: "fake",
	webhookSecret: "secret",
	databaseUrl: "postgres://test",
	role: "web",
	piProvider: "openai",
	piModel: "gpt-4o-mini",
	maxToolRounds: 24,
	maxFinalizeRounds: 6,
	maxReviewPublishAttempts: 3,
	reviewConcurrency: 2,
	askConcurrency: 1,
	ackConcurrency: 2,
	queueRetryLimit: 3,
	queueRetryDelaySeconds: 30,
	queueRetryDelayMaxSeconds: 300,
	queueExpireInSeconds: 3600,
	queueHeartbeatSeconds: 60,
	queueRetentionSeconds: 1209600,
	queueDeleteAfterSeconds: 604800,
	installationGroupConcurrency: 2,
	maxAskToolRounds: 12,
	webhookTimeoutMs: 10000,
	context7ApiKey: "",
	maxReviewFindings: 8,
	enableReviewLabelsEffort: false,
	enableReviewLabelsSecurity: false,
	maxPrFilesListed: 300,
	maxPrFilesPatchBytes: 500000,
	logLevel: "error",
};

function get(port: number, path: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		http
			.get({ hostname: "127.0.0.1", port, path }, (res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c) => chunks.push(Buffer.from(c)));
				res.on("end", () => {
					resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
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
				headers: { "content-type": "application/json", "content-length": body.length, ...headers },
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c) => chunks.push(Buffer.from(c)));
				res.on("end", () => {
					resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
				});
			},
		);
		req.on("error", reject);
		req.end(body);
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

function startEffectServer(): Promise<Handle> {
	return new Promise((resolve, reject) => {
		let captured: http.Server | undefined;
		const dispatcherLayer = Layer.succeed(
			WebhookDispatcher,
			WebhookDispatcher.of({
				dispatch: () => Effect.void,
			}),
		);
		const layer = buildEffectWebhookLayer(testCfg, () => {
			captured = http.createServer();
			captured.once("listening", () => {
				if (captured) resolve({ server: captured, fiber });
			});
			captured.once("error", reject);
			return captured;
		}, dispatcherLayer);
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
