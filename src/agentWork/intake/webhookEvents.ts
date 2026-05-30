import crypto from "node:crypto";
import type { PoolClient } from "pg";
import type { WebhookHeaders } from "../types.js";

type EventRecord = {
  readonly id: string;
  readonly duplicate: boolean;
};

function bodySha(rawBody: Buffer): string {
  return crypto.createHash("sha256").update(rawBody).digest("hex");
}

export function dedupeKey(headers: WebhookHeaders): string {
  return headers.delivery ? `delivery:${headers.delivery}` : `body:${bodySha(headers.rawBody)}`;
}

export async function insertWebhookEvent(
  client: PoolClient,
  headers: WebhookHeaders,
  decision: string,
): Promise<EventRecord> {
  const id = crypto.randomUUID();
  const result = await client.query<{ id: string }>(
    `INSERT INTO webhook_events (id, dedupe_key, delivery_id, event_name, body_sha256, processing_decision, processed_at)
		 VALUES ($1, $2, $3, $4, $5, $6, now())
		 ON CONFLICT (dedupe_key) DO NOTHING
		 RETURNING id`,
    [
      id,
      dedupeKey(headers),
      headers.delivery ?? null,
      headers.event ?? "",
      bodySha(headers.rawBody),
      decision,
    ],
  );
  const inserted = result.rows[0]?.id;
  return inserted ? { id: inserted, duplicate: false } : { id: "", duplicate: true };
}
