import http from "node:http";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Effect, Fiber, Layer } from "effect";
import type { Config } from "../src/config.js";
import { initLog } from "../src/log.js";
import { buildEffectWebhookLayer } from "../src/effect/server.js";

const testCfg: Config = {
	port: 0,
	githubAppId: "1",
	githubAppPrivateKey: "fake",
	webhookSecret: "secret",
	piProvider: "openai",
	piModel: "gpt-4o-mini",
	maxToolRounds: 24,
	maxFinalizeRounds: 6,
	reviewConcurrency: 2,
	webhookTimeoutMs: 10000,
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

type Handle = { server: http.Server; fiber: Fiber.RuntimeFiber<void, unknown> };

function startEffectServer(): Promise<Handle> {
	return new Promise((resolve, reject) => {
		let captured: http.Server | undefined;
		const layer = buildEffectWebhookLayer(testCfg, () => {
			captured = http.createServer();
			captured.once("listening", () => {
				if (captured) resolve({ server: captured, fiber });
			});
			captured.once("error", reject);
			return captured;
		});
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
		initLog("error");
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
});
