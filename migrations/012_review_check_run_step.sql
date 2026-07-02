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
    'triage_report'
  ));

DROP INDEX IF EXISTS publish_records_unique_shared_step_idx;

CREATE UNIQUE INDEX IF NOT EXISTS publish_records_unique_shared_step_idx
  ON publish_records (resource_key, review_lens, step)
  WHERE review_lens <> 'ask'
    AND step <> 'check_run';

CREATE UNIQUE INDEX IF NOT EXISTS publish_records_unique_check_run_work_item_step_idx
  ON publish_records (work_item_id, review_lens, step)
  WHERE step = 'check_run';
