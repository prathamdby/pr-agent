CREATE TABLE IF NOT EXISTS pr_head_ci_state (
  owner text NOT NULL,
  repo text NOT NULL,
  head_sha text NOT NULL,
  checks jsonb NOT NULL DEFAULT '{}'::jsonb,
  rollup text NOT NULL CHECK (rollup IN ('pending', 'passing', 'failing', 'none', 'unknown')),
  version bigint NOT NULL,
  authored jsonb,
  pr_numbers jsonb NOT NULL DEFAULT '[]'::jsonb,
  truncated boolean NOT NULL DEFAULT false,
  seeded_at timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner, repo, head_sha)
);

CREATE INDEX IF NOT EXISTS pr_head_ci_state_updated_at_idx
  ON pr_head_ci_state (updated_at);

CREATE INDEX IF NOT EXISTS agent_work_items_owner_repo_head_sha_idx
  ON agent_work_items (owner, repo, head_sha);

ALTER TABLE publish_records DROP CONSTRAINT IF EXISTS publish_records_step_check;
ALTER TABLE publish_records ADD CONSTRAINT publish_records_step_check
  CHECK (step IN (
    'progress_comment',
    'inline_review',
    'summary_comment',
    'summary_comment_claim',
    'check_run',
    'labels',
    'pr_body',
    'ask_reply',
    'triage_push',
    'triage_thread_actions',
    'triage_report',
    'triage_preview',
    'verification_thread_actions',
    'ci_cell',
    'commit_status',
    'verification_failure'
  ));
