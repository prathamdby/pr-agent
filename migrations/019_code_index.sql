CREATE TABLE IF NOT EXISTS code_index_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id bigint NOT NULL,
  owner text NOT NULL,
  repo text NOT NULL,
  head_sha text NOT NULL,
  status text NOT NULL CHECK (status IN ('building', 'ready', 'failed', 'superseded')),
  chunker_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (installation_id, owner, repo, head_sha)
);

CREATE TABLE IF NOT EXISTS code_index_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL REFERENCES code_index_snapshots(id) ON DELETE CASCADE,
  path text NOT NULL,
  start_line integer NOT NULL,
  end_line integer NOT NULL,
  symbol_names text[] NOT NULL DEFAULT '{}',
  content text NOT NULL,
  content_hash bytea NOT NULL,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
);

CREATE INDEX IF NOT EXISTS code_index_chunks_snapshot_id_idx
  ON code_index_chunks (snapshot_id);

CREATE INDEX IF NOT EXISTS code_index_chunks_tsv_idx
  ON code_index_chunks USING GIN (tsv);

CREATE INDEX IF NOT EXISTS code_index_snapshots_repo_status_idx
  ON code_index_snapshots (installation_id, owner, repo, status, updated_at DESC);
