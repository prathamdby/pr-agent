ALTER TABLE publish_records DROP CONSTRAINT IF EXISTS publish_records_review_lens_check;
ALTER TABLE publish_records ADD CONSTRAINT publish_records_review_lens_check
  CHECK (review_lens IN ('review', 'review-security', 'review-quality', 'description', 'ask'));

ALTER TABLE publish_records DROP CONSTRAINT IF EXISTS publish_records_step_check;
ALTER TABLE publish_records ADD CONSTRAINT publish_records_step_check
  CHECK (step IN ('progress_comment', 'inline_review', 'summary_comment', 'labels', 'pr_body', 'ask_reply'));

ALTER TABLE publish_records DROP CONSTRAINT IF EXISTS publish_records_resource_key_review_lens_step_key;

CREATE UNIQUE INDEX IF NOT EXISTS publish_records_unique_shared_step_idx
  ON publish_records (resource_key, review_lens, step)
  WHERE review_lens <> 'ask';

CREATE UNIQUE INDEX IF NOT EXISTS publish_records_unique_ask_work_item_step_idx
  ON publish_records (work_item_id, review_lens, step)
  WHERE review_lens = 'ask';
