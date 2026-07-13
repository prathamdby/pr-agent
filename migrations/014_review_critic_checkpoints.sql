CREATE TABLE IF NOT EXISTS review_critic_checkpoints (
  id uuid PRIMARY KEY,
  work_item_id uuid NOT NULL REFERENCES agent_work_items(id) ON DELETE CASCADE,
  head_sha text NOT NULL,
  evidence_hash text NOT NULL,
  critic_id text NOT NULL,
  prompt_contract_version integer NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('in_progress', 'completed', 'exhausted')),
  report jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (work_item_id, head_sha, evidence_hash, critic_id, prompt_contract_version)
);

CREATE INDEX IF NOT EXISTS review_critic_checkpoints_work_item_idx
  ON review_critic_checkpoints (work_item_id);

CREATE TABLE IF NOT EXISTS review_payload_checkpoints (
  work_item_id uuid PRIMARY KEY REFERENCES agent_work_items(id) ON DELETE CASCADE,
  head_sha text NOT NULL,
  evidence_hash text NOT NULL,
  prompt_contract_version integer NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
