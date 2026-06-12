ALTER TABLE publish_records DROP CONSTRAINT IF EXISTS publish_records_review_lens_check;
ALTER TABLE publish_records ADD CONSTRAINT publish_records_review_lens_check
  CHECK (review_lens IN ('review', 'review-security', 'review-quality', 'description', 'ask'));

ALTER TABLE publish_records DROP CONSTRAINT IF EXISTS publish_records_step_check;
ALTER TABLE publish_records ADD CONSTRAINT publish_records_step_check
  CHECK (step IN ('progress_comment', 'inline_review', 'summary_comment', 'labels', 'pr_body', 'ask_reply'));
