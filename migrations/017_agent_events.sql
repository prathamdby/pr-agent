CREATE TABLE IF NOT EXISTS agent_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id uuid REFERENCES agent_work_items(id) ON DELETE SET NULL,
  installation_id bigint,
  owner text,
  repo text,
  pr_number integer,
  session_role text,
  event_kind text NOT NULL,
  phase text,
  checkpoint_id text,
  tool_name text,
  provider text,
  model text,
  ok boolean,
  failure_code text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_events_work_item_recorded_idx
  ON agent_events (work_item_id, recorded_at);

CREATE INDEX IF NOT EXISTS agent_events_install_recorded_idx
  ON agent_events (installation_id, recorded_at);
