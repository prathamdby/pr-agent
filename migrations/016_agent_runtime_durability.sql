-- Durable Agent phase checkpoints, operation intents, and encrypted resume snapshots.

CREATE TABLE IF NOT EXISTS agent_phase_checkpoints (
  id uuid PRIMARY KEY,
  work_item_id uuid NOT NULL REFERENCES agent_work_items(id) ON DELETE CASCADE,
  session_role text NOT NULL CHECK (
    session_role IN (
      'orchestrator',
      'specialist',
      'ask',
      'description',
      'triage',
      'verification',
      'ci_summary'
    )
  ),
  checkpoint_id text NOT NULL,
  phase text NOT NULL,
  structured_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (work_item_id, session_role)
);

CREATE INDEX IF NOT EXISTS agent_phase_checkpoints_work_item_idx
  ON agent_phase_checkpoints (work_item_id);

CREATE TABLE IF NOT EXISTS operation_intents (
  id uuid PRIMARY KEY,
  work_item_id uuid NOT NULL REFERENCES agent_work_items(id) ON DELETE CASCADE,
  operation_key text NOT NULL,
  mutation_kind text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'reconciled', 'failed')),
  publish_record_id uuid REFERENCES publish_records(id) ON DELETE SET NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  reconciled_at timestamptz,
  UNIQUE (work_item_id, operation_key)
);

CREATE INDEX IF NOT EXISTS operation_intents_work_item_status_idx
  ON operation_intents (work_item_id, status);

CREATE TABLE IF NOT EXISTS agent_resume_snapshots (
  id uuid PRIMARY KEY,
  work_item_id uuid NOT NULL REFERENCES agent_work_items(id) ON DELETE CASCADE,
  session_role text NOT NULL CHECK (
    session_role IN (
      'orchestrator',
      'specialist',
      'ask',
      'description',
      'triage',
      'verification',
      'ci_summary'
    )
  ),
  installation_id bigint NOT NULL,
  envelope_version integer NOT NULL DEFAULT 1,
  model_provider text NOT NULL,
  model_id text NOT NULL,
  sdk_version text NOT NULL,
  prompt_version text NOT NULL,
  tool_policy_version text NOT NULL,
  checkpoint_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  nonce bytea NOT NULL,
  ciphertext bytea NOT NULL,
  auth_tag bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (work_item_id, session_role)
);

CREATE INDEX IF NOT EXISTS agent_resume_snapshots_expires_at_idx
  ON agent_resume_snapshots (expires_at);
