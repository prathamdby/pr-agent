import crypto from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { WebhookHeaders } from "../types.js";

type EventRecord = {
  readonly id: string;
  readonly duplicate: boolean;
  readonly dedupeKey: string;
};

function bodySha(rawBody: Buffer): string {
  return crypto.createHash("sha256").update(rawBody).digest("hex");
}

function webhookEventKeys(headers: WebhookHeaders): {
  readonly dedupeKey: string;
  readonly bodySha256: string;
} {
  const bodySha256 = bodySha(headers.rawBody);
  return {
    dedupeKey: headers.delivery ? `delivery:${headers.delivery}` : `body:${bodySha256}`,
    bodySha256,
  };
}

export async function insertWebhookEvent(
  client: Pool | PoolClient,
  headers: WebhookHeaders,
  decision: string,
): Promise<EventRecord> {
  const id = crypto.randomUUID();
  const keys = webhookEventKeys(headers);
  const result = await client.query<{ id: string }>(
    `INSERT INTO webhook_events (id, dedupe_key, delivery_id, event_name, body_sha256, processing_decision, processed_at)
		 VALUES ($1, $2, $3, $4, $5, $6, now())
		 ON CONFLICT (dedupe_key) DO NOTHING
		 RETURNING id`,
    [id, keys.dedupeKey, headers.delivery ?? null, headers.event ?? "", keys.bodySha256, decision],
  );
  const inserted = result.rows[0]?.id;
  return {
    id: inserted ?? "",
    duplicate: inserted == null,
    dedupeKey: keys.dedupeKey,
  };
}
