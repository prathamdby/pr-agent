-- One-time legacy CI projection repair flag.
-- Existing rows need a format upgrade pass; new rows start clear.
ALTER TABLE pr_head_ci_state
  ADD COLUMN IF NOT EXISTS projection_repair_pending boolean NOT NULL DEFAULT true;

ALTER TABLE pr_head_ci_state
  ALTER COLUMN projection_repair_pending SET DEFAULT false;

UPDATE pr_head_ci_state
   SET projection_repair_pending = true
 WHERE projection_repair_pending IS DISTINCT FROM true;

CREATE INDEX IF NOT EXISTS pr_head_ci_state_projection_repair_pending_idx
  ON pr_head_ci_state (owner, repo, head_sha)
 WHERE projection_repair_pending;
