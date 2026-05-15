import crypto from "node:crypto";

/**
 * In-memory dedupe of webhook deliveries. Primary key is `X-GitHub-Delivery`.
 * If GitHub omits that header, we fall back to **SHA-256 of the raw body** so identical redeliveries still dedupe.
 */
const seen = new Map<string, number>();
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export function deliveryDedupeKey(deliveryId: string | undefined, rawBody: Buffer): string {
	if (deliveryId && deliveryId.trim().length > 0) return deliveryId;
	return `body:${crypto.createHash("sha256").update(rawBody).digest("hex")}`;
}

export function isDuplicateDelivery(deliveryKey: string, ttlMs = DEFAULT_TTL_MS): boolean {
	const now = Date.now();
	prune(now, ttlMs);
	if (seen.has(deliveryKey)) return true;
	seen.set(deliveryKey, now);
	return false;
}

function prune(now: number, ttlMs: number) {
	for (const [id, t] of seen) {
		if (now - t > ttlMs) seen.delete(id);
	}
}
