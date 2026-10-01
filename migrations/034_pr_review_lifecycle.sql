CREATE TABLE IF NOT EXISTS pr_review_lifecycle (
  resource_key text PRIMARY KEY,
  state text NOT NULL CHECK (state IN ('open', 'closed', 'merged')),
  observed_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  webhook_event_id uuid REFERENCES webhook_events(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS pr_review_lifecycle_webhook_event_id_idx
  ON pr_review_lifecycle (webhook_event_id)
  WHERE webhook_event_id IS NOT NULL;
