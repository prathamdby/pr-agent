import http from "node:http";
import type { Config } from "../config.js";
import { verifyGithubWebhookSignature } from "./verifySignature.js";
import { dispatchGithubEvent } from "./dispatch.js";
import { log } from "../log.js";

function readRawBody(req: http.IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(Buffer.from(c)));
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

function requestPath(url: string | undefined): string {
	return url?.split("?")[0] ?? "";
}

export function startWebhookServer(cfg: Config) {
	const server = http.createServer(async (req, res) => {
		try {
			const path = requestPath(req.url);
			if (req.method === "GET" && path === "/health") {
				res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("ok");
				return;
			}

			if (req.method !== "POST" || path !== "/webhooks") {
				res.writeHead(404).end();
				return;
			}

			const raw = await readRawBody(req);
			const sig = req.headers["x-hub-signature-256"];
			const sigStr = Array.isArray(sig) ? sig[0] : sig;

			if (!verifyGithubWebhookSignature(cfg.webhookSecret, raw, sigStr)) {
				log.warn("invalid_signature");
				res.writeHead(401).end("invalid signature");
				return;
			}

			const event = req.headers["x-github-event"];
			const eventStr = Array.isArray(event) ? event[0] : event ?? "";
			const delivery = req.headers["x-github-delivery"];
			const deliveryStr = Array.isArray(delivery) ? delivery[0] : delivery;

			let payload: Record<string, unknown>;
			try {
				payload = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
			} catch {
				res.writeHead(400).end("invalid json");
				return;
			}

			const t0 = Date.now();
			await dispatchGithubEvent(cfg, { delivery: deliveryStr, event: eventStr, rawBody: raw }, payload);
			log.info("webhook_handled", { event: eventStr, delivery: deliveryStr, ms: Date.now() - t0 });

			res.writeHead(200).end("ok");
		} catch (e) {
			log.error("webhook_fatal", { message: e instanceof Error ? e.message : String(e) });
			res.writeHead(500).end("error");
		}
	});

	server.listen(cfg.port, () => {
		const addr = server.address();
		const bound = typeof addr === "object" && addr ? addr.port : cfg.port;
		log.info("listening", { port: bound });
	});

	return server;
}
