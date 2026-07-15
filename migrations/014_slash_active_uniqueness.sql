-- One active slash review/description/triage per resource+type+lens.
-- Exclude stale-head replacements so parent-running + replacement-queued stays legal.

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
    AND type IN ('review', 'description', 'triage')
    AND status IN ('queued', 'running')
    AND (payload->>'staleHeadRescheduled') IS DISTINCT FROM 'true'
)
UPDATE agent_work_items AS awi
SET
  status = 'cancelled',
  last_error = 'Cancelled by migration 014_slash_active_uniqueness: duplicate active slash work item',
  completed_at = now(),
  updated_at = now()
FROM ranked
WHERE awi.id = ranked.id
  AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS agent_work_items_slash_active_uniqueness_idx
  ON agent_work_items (resource_key, type, review_lens)
  NULLS NOT DISTINCT
  WHERE source = 'slash'
    AND type IN ('review', 'description', 'triage')
    AND status IN ('queued', 'running')
    AND (payload->>'staleHeadRescheduled') IS DISTINCT FROM 'true';
