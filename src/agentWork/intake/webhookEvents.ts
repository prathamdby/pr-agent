import crypto from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  IGNORED_BOT_SLASH_COMMAND,
  IGNORED_NON_BOT_THREAD_REPLY,
  IGNORED_UNAUTHORIZED_SLASH,
  THREAD_REPLY_ASK_ENQUEUED,
  THREAD_REPLY_CLASSIFICATION_FAILED,
  THREAD_REPLY_CLASSIFICATION_QUEUED,
} from "../../settings/index.js";
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
  if (inserted == null) {
    return {
      duplicate: true,
      dedupeKey: keys.dedupeKey,
    };
  }
  return {
    id: inserted,
    duplicate: false,
    dedupeKey: keys.dedupeKey,
  };
}

const TERMINAL_THREAD_REPLY_DECISIONS = new Set<string>([
  THREAD_REPLY_ASK_ENQUEUED,
  THREAD_REPLY_CLASSIFICATION_FAILED,
  IGNORED_NON_BOT_THREAD_REPLY,
  IGNORED_BOT_SLASH_COMMAND,
  IGNORED_UNAUTHORIZED_SLASH,
]);

export function isTerminalThreadReplyDecision(decision: string): boolean {
  return TERMINAL_THREAD_REPLY_DECISIONS.has(decision);
}

export async function lockWebhookEventForUpdate(
  client: PoolClient,
  eventId: string,
): Promise<{ id: string; processingDecision: string } | null> {
  const result = await client.query<{ id: string; processing_decision: string }>(
    `SELECT id, processing_decision
       FROM webhook_events
      WHERE id = $1
      FOR UPDATE`,
    [eventId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { id: row.id, processingDecision: row.processing_decision };
}

export async function updateWebhookEventDecision(
  client: Pool | PoolClient,
  eventId: string,
  decision: string,
  errorMessage: string | null = null,
): Promise<void> {
  await client.query(
    `UPDATE webhook_events
        SET processing_decision = $2,
            error_message = $3,
            processed_at = now()
      WHERE id = $1`,
    [eventId, decision, errorMessage],
  );
}

export function isThreadReplyClassificationQueued(decision: string): boolean {
  return decision === THREAD_REPLY_CLASSIFICATION_QUEUED;
}
