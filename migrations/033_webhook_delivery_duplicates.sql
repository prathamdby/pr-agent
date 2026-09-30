-- Each rejected arrival has its own lifetime, independent of accepted events
-- and their replay reservations. This table never participates in deduplication.
CREATE TABLE IF NOT EXISTS webhook_delivery_duplicates (
  id uuid PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now(),
  delivery_id text,
  event_name text NOT NULL,
  body_sha256 text NOT NULL,
  dedupe_key text NOT NULL,
  dedupe_reason text NOT NULL CHECK (dedupe_reason IN ('delivery_key', 'body_key', 'body_replay'))
);

CREATE INDEX IF NOT EXISTS webhook_delivery_duplicates_received_at_idx
  ON webhook_delivery_duplicates (received_at);

CREATE INDEX IF NOT EXISTS webhook_delivery_duplicates_delivery_id_received_at_idx
  ON webhook_delivery_duplicates (delivery_id, received_at);

CREATE INDEX IF NOT EXISTS webhook_delivery_duplicates_body_sha256_received_at_idx
  ON webhook_delivery_duplicates (body_sha256, received_at);
