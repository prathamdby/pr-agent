ALTER TABLE agent_work_items DROP CONSTRAINT IF EXISTS agent_work_items_review_lens_check;
ALTER TABLE agent_work_items ADD CONSTRAINT agent_work_items_review_lens_check
  CHECK (review_lens IN ('review', 'review-security', 'review-quality', 'review-tests'));

ALTER TABLE publish_records DROP CONSTRAINT IF EXISTS publish_records_review_lens_check;
ALTER TABLE publish_records ADD CONSTRAINT publish_records_review_lens_check
  CHECK (review_lens IN ('review', 'review-security', 'review-quality', 'review-tests', 'description', 'ask'));
