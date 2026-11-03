CREATE TABLE agent_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_key text,
  group_key text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  work_item_id uuid REFERENCES agent_work_items(id) ON DELETE SET NULL,
  installation_id bigint,
  owner text,
  repo text,
  pr_number integer,
  execution_id text,
  attempt_count integer,
  session_role text,
  specialist text,
  provider text,
  model text,
  tool_call_id text,
  obstacle text NOT NULL CHECK (obstacle IN ('tool', 'prompt', 'input', 'instruction')),
  subject text NOT NULL,
  intent text NOT NULL,
  problem text NOT NULL,
  expected text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('blocked', 'degraded', 'noise'))
);

CREATE UNIQUE INDEX agent_feedback_delivery_key_uidx
  ON agent_feedback (delivery_key)
  WHERE delivery_key IS NOT NULL;

CREATE INDEX agent_feedback_group_idx
  ON agent_feedback (group_key, recorded_at);

CREATE INDEX agent_feedback_work_item_idx
  ON agent_feedback (work_item_id)
  WHERE work_item_id IS NOT NULL;

CREATE INDEX agent_feedback_recorded_at_idx
  ON agent_feedback (recorded_at);
