ALTER TABLE agent_work_items DROP CONSTRAINT IF EXISTS agent_work_items_type_check;
ALTER TABLE agent_work_items ADD CONSTRAINT agent_work_items_type_check
  CHECK (type IN ('review', 'ask', 'description', 'fix'));

CREATE TABLE IF NOT EXISTS auto_fix_bundles (
  id uuid PRIMARY KEY,
  work_item_id uuid NOT NULL REFERENCES agent_work_items(id) ON DELETE CASCADE,
  resource_key text NOT NULL,
  review_lens text NOT NULL CHECK (review_lens IN ('review', 'review-security', 'review-quality')),
  head_sha text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auto_fix_bundles_resource_lens_created_idx
  ON auto_fix_bundles (resource_key, review_lens, created_at DESC);

CREATE TABLE IF NOT EXISTS auto_fix_targets (
  id uuid PRIMARY KEY,
  bundle_id uuid NOT NULL REFERENCES auto_fix_bundles(id) ON DELETE CASCADE,
  work_item_id uuid NOT NULL REFERENCES agent_work_items(id) ON DELETE CASCADE,
  resource_key text NOT NULL,
  review_lens text NOT NULL CHECK (review_lens IN ('review', 'review-security', 'review-quality')),
  head_sha text NOT NULL,
  fingerprint text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('P0', 'P1', 'P2')),
  file_path text NOT NULL,
  start_line integer NOT NULL,
  end_line integer NOT NULL,
  title text NOT NULL,
  detail text NOT NULL,
  fix_prompt text NOT NULL,
  placement_kind text NOT NULL CHECK (placement_kind IN ('inline', 'summary')),
  inline_review_comment_id bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auto_fix_targets_bundle_idx
  ON auto_fix_targets (bundle_id);

CREATE INDEX IF NOT EXISTS auto_fix_targets_inline_comment_idx
  ON auto_fix_targets (resource_key, inline_review_comment_id)
  WHERE inline_review_comment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS auto_fix_targets_resource_lens_idx
  ON auto_fix_targets (resource_key, review_lens, created_at DESC);
