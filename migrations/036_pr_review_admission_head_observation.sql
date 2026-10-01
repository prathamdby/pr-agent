ALTER TABLE pr_review_admission
  ADD COLUMN head_observed_at timestamptz,
  ADD COLUMN opened_seen boolean NOT NULL DEFAULT true;
