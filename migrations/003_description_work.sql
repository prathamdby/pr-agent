ALTER TABLE agent_work_items DROP CONSTRAINT IF EXISTS agent_work_items_type_check;
ALTER TABLE agent_work_items ADD CONSTRAINT agent_work_items_type_check
  CHECK (type IN ('review', 'ask', 'description'));

ALTER TABLE publish_records DROP CONSTRAINT IF EXISTS publish_records_review_lens_check;
ALTER TABLE publish_records ADD CONSTRAINT publish_records_review_lens_check
  CHECK (review_lens IN ('review', 'review-security', 'review-quality', 'description'));

ALTER TABLE publish_records DROP CONSTRAINT IF EXISTS publish_records_step_check;
ALTER TABLE publish_records ADD CONSTRAINT publish_records_step_check
  CHECK (step IN ('progress_comment', 'inline_review', 'summary_comment', 'labels', 'pr_body'));
