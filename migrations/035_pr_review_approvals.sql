-- 035_pr_review_approvals
CREATE TABLE pr_review_approvals (
  resource_key text PRIMARY KEY,
  owner text NOT NULL,
  repo text NOT NULL,
  pr_number integer NOT NULL,
  head_sha text NOT NULL,
  state text NOT NULL CHECK (state IN ('awaiting', 'approved', 'withdrawn')),
  approved_by text CHECK (approved_by IN ('workflow_run', 'pull_request_review', 'slash')),
  webhook_event_id uuid REFERENCES webhook_events(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX pr_review_approvals_awaiting_head_idx
  ON pr_review_approvals (owner, repo, head_sha) WHERE state = 'awaiting';
