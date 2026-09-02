-- One active slash verification per resource (extends the 014 slash_active
-- pattern, which covers review/description/triage only).
-- Cancel duplicate queued/running slash verification rows so the partial
-- unique index below can be created, keeping the earliest running row.

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY resource_key, type, review_lens
      ORDER BY
        CASE status WHEN 'running' THEN 0 ELSE 1 END,
        created_at ASC,
        id ASC
    ) AS rn
  FROM agent_work_items
  WHERE source = 'slash'
    AND type = 'verification'
    AND status IN ('queued', 'running')
    AND (payload->>'staleHeadRescheduled') IS DISTINCT FROM 'true'
)
UPDATE agent_work_items AS awi
SET
  status = 'cancelled',
  last_error = 'Cancelled by migration 027_verification_slash_active_uniqueness: duplicate active slash verification work item',
  completed_at = now(),
  updated_at = now()
FROM ranked
WHERE awi.id = ranked.id
  AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS agent_work_items_slash_active_verification_uniqueness_idx
  ON agent_work_items (resource_key, type, review_lens)
  NULLS NOT DISTINCT
  WHERE source = 'slash'
    AND type = 'verification'
    AND status IN ('queued', 'running')
    AND (payload->>'staleHeadRescheduled') IS DISTINCT FROM 'true';
