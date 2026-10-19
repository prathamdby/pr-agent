SET LOCAL lock_timeout = '3s';
ALTER TABLE pr_review_approvals
  ADD COLUMN workflow_start_admits boolean NOT NULL DEFAULT true;
