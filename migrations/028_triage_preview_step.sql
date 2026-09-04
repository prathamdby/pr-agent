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
    'verification_thread_actions'
  ));
