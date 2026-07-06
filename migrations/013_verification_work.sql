ALTER TABLE agent_work_items DROP CONSTRAINT IF EXISTS agent_work_items_type_check;
ALTER TABLE agent_work_items ADD CONSTRAINT agent_work_items_type_check
  CHECK (type IN ('review', 'ask', 'description', 'triage', 'verification'));

ALTER TABLE publish_records DROP CONSTRAINT IF EXISTS publish_records_review_lens_check;
ALTER TABLE publish_records ADD CONSTRAINT publish_records_review_lens_check
  CHECK (review_lens IN ('review', 'review-security', 'review-quality', 'review-tests', 'description', 'ask', 'triage', 'verification'));

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
    'verification_thread_actions'
  ));
