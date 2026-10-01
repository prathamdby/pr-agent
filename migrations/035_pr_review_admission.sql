CREATE TABLE IF NOT EXISTS pr_review_admission (
  resource_key text PRIMARY KEY,
  owner text NOT NULL,
  repo text NOT NULL,
  pr_number integer NOT NULL,
  head_sha text NOT NULL,
  author_id bigint,
  state text NOT NULL CHECK (state IN ('pending', 'admitted')),
  admitted_via text CHECK (admitted_via IN ('author', 'workflow', 'review', 'slash', 'legacy_review')),
  admitted_by bigint,
  webhook_event_id uuid REFERENCES webhook_events(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'pending' AND admitted_via IS NULL AND admitted_by IS NULL)
      OR (state = 'admitted' AND admitted_via IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS pr_review_admission_pending_head_idx
  ON pr_review_admission (owner, repo, head_sha) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS pr_review_admission_webhook_event_id_idx
  ON pr_review_admission (webhook_event_id) WHERE webhook_event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS workflow_run_approval_holds (
  run_id bigint PRIMARY KEY,
  owner text NOT NULL,
  repo text NOT NULL,
  head_sha text NOT NULL,
  state text NOT NULL CHECK (state IN ('awaiting', 'approved')),
  approved_by bigint,
  observed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'awaiting' AND approved_by IS NULL)
      OR (state = 'approved' AND approved_by IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS workflow_run_approval_holds_approved_head_idx
  ON workflow_run_approval_holds (owner, repo, head_sha) WHERE state = 'approved';
