import http from "node:http";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { initLog } from "../src/log.js";
import { startWebhookServer } from "../src/webhook/server.js";

const testCfg: Config = {
	port: 0,
	githubAppId: "1",
	githubAppPrivateKey: "fake",
	webhookSecret: "secret",
	piProvider: "openai",
	piModel: "gpt-4o-mini",
	maxToolRounds: 24,
	maxFinalizeRounds: 6,
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

describe("startWebhookServer routes", () => {
	beforeAll(() => {
		initLog("error");
	});

	let server: http.Server | undefined;

	afterEach(async () => {
		if (!server) return;
		await new Promise<void>((resolve, reject) => {
			server!.close((err) => (err ? reject(err) : resolve()));
		});
		server = undefined;
	});

	function awaitListening(s: http.Server) {
		return new Promise<void>((resolve) => {
			if (s.listening) resolve();
			else s.once("listening", () => resolve());
		});
	}

	it("returns 200 plain ok for GET /health", async () => {
		const s = startWebhookServer({ ...testCfg, port: 0 });
		server = s;
		await awaitListening(s);
		const addr = s.address();
		if (typeof addr !== "object" || !addr?.port) throw new Error("no port");
		const res = await get(addr.port, "/health");
		expect(res.status).toBe(200);
		expect(res.body).toBe("ok");
	});

	it("returns 404 for unknown GET path", async () => {
		const s = startWebhookServer({ ...testCfg, port: 0 });
		server = s;
		await awaitListening(s);
		const addr = s.address();
		if (typeof addr !== "object" || !addr?.port) throw new Error("no port");
		const res = await get(addr.port, "/nope");
		expect(res.status).toBe(404);
	});
});
