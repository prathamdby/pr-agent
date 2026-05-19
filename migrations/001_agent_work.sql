CREATE TABLE IF NOT EXISTS webhook_events (
  id uuid PRIMARY KEY,
  dedupe_key text NOT NULL UNIQUE,
  delivery_id text,
  event_name text NOT NULL,
  body_sha256 text NOT NULL,
  processing_decision text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  error_message text
);

CREATE INDEX IF NOT EXISTS webhook_events_received_at_idx ON webhook_events (received_at DESC);

CREATE TABLE IF NOT EXISTS agent_work_items (
  id uuid PRIMARY KEY,
  webhook_event_id uuid REFERENCES webhook_events(id) ON DELETE SET NULL,
  type text NOT NULL CHECK (type IN ('review', 'ask')),
  source text NOT NULL CHECK (source IN ('auto', 'slash')),
  status text NOT NULL CHECK (
    status IN ('queued', 'running', 'superseded', 'cancelled', 'completed', 'failed')
  ),
  owner text NOT NULL,
  repo text NOT NULL,
  pr_number integer NOT NULL,
  installation_id bigint NOT NULL,
  head_sha text NOT NULL,
  review_lens text CHECK (review_lens IN ('review', 'review-security')),
  resource_key text NOT NULL,
  priority integer NOT NULL DEFAULT 0,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  cancel_requested_at timestamptz,
  superseded_by uuid REFERENCES agent_work_items(id) ON DELETE SET NULL,
  last_error text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_work_items_status_idx ON agent_work_items (status);
CREATE INDEX IF NOT EXISTS agent_work_items_resource_status_idx
  ON agent_work_items (resource_key, review_lens, status);
CREATE INDEX IF NOT EXISTS agent_work_items_installation_status_idx
  ON agent_work_items (installation_id, status);

CREATE TABLE IF NOT EXISTS publish_records (
  id uuid PRIMARY KEY,
  work_item_id uuid REFERENCES agent_work_items(id) ON DELETE CASCADE,
  resource_key text NOT NULL,
  review_lens text NOT NULL CHECK (review_lens IN ('review', 'review-security')),
  step text NOT NULL CHECK (step IN ('progress_comment', 'inline_review', 'summary_comment', 'labels')),
  github_id text,
  status text NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (resource_key, review_lens, step)
);

