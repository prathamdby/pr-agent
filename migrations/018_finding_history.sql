CREATE TABLE IF NOT EXISTS repo_finding_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id bigint NOT NULL,
  owner text NOT NULL,
  repo text NOT NULL,
  fingerprint text NOT NULL,
  last_outcome text NOT NULL CHECK (
    last_outcome IN ('open', 'fixed', 'already-resolved', 'dismissed', 'skipped')
  ),
  dismiss_count integer NOT NULL DEFAULT 0,
  fix_count integer NOT NULL DEFAULT 0,
  open_count integer NOT NULL DEFAULT 0,
  last_pr_number integer,
  last_work_item_id uuid,
  last_head_sha text,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (installation_id, owner, repo, fingerprint)
);

CREATE INDEX IF NOT EXISTS repo_finding_history_repo_idx
  ON repo_finding_history (installation_id, owner, repo, last_seen_at DESC);
