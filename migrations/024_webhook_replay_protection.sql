-- Keep body-hash replay state separate from delivery-id history so existing
-- databases with legacy duplicate body hashes can migrate without data loss.
CREATE TABLE IF NOT EXISTS webhook_event_replays (
  body_sha256 text PRIMARY KEY,
  webhook_event_id uuid NOT NULL REFERENCES webhook_events(id) ON DELETE CASCADE,
  accepted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS webhook_event_replays_webhook_event_id_idx
  ON webhook_event_replays (webhook_event_id);

-- Backfill one durable replay record per body from the most recent event history
-- so legacy duplicates keep the hash reserved for the newest retained event.
INSERT INTO webhook_event_replays (body_sha256, webhook_event_id, accepted_at)
SELECT DISTINCT ON (body_sha256) body_sha256, id, received_at
  FROM webhook_events
 ORDER BY body_sha256, received_at DESC, id DESC
ON CONFLICT (body_sha256) DO NOTHING;
