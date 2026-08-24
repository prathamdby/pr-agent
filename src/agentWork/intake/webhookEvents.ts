import crypto from "node:crypto";
import type { PoolClient } from "pg";
import type { WebhookHeaders } from "../types.js";

type EventRecord =
  | {
      readonly id: string;
      readonly duplicate: false;
      readonly dedupeKey: string;
    }
  | {
      readonly id?: undefined;
      readonly duplicate: true;
      readonly dedupeKey: string;
    };

function webhookEventKeys(headers: WebhookHeaders): {
  readonly dedupeKey: string;
  readonly bodyDedupeKey: string;
  readonly bodySha256: string;
} {
  const bodySha256 = crypto.createHash("sha256").update(headers.rawBody).digest("hex");
  return {
    dedupeKey: headers.delivery ? `delivery:${headers.delivery}` : `body:${bodySha256}`,
    bodyDedupeKey: `body:${bodySha256}`,
    bodySha256,
  };
}

export async function insertWebhookEvent(
  client: PoolClient,
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
  if (inserted == null) {
    return {
      duplicate: true,
      dedupeKey: keys.dedupeKey,
    };
  }

  const replay = await client.query<{ body_sha256: string }>(
    `INSERT INTO webhook_event_replays (body_sha256, webhook_event_id)
		 VALUES ($1, $2)
		 ON CONFLICT (body_sha256) DO NOTHING
		 RETURNING body_sha256`,
    [keys.bodySha256, inserted],
  );
  if (replay.rows[0]?.body_sha256 == null) {
    await client.query("DELETE FROM webhook_events WHERE id = $1", [inserted]);
    return {
      duplicate: true,
      dedupeKey: keys.bodyDedupeKey,
    };
  }

  return {
    id: inserted,
    duplicate: false,
    dedupeKey: keys.dedupeKey,
  };
}
