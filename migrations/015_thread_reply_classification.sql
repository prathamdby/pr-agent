-- One ask work item per non-null webhook_event_id (classifier + slash ask idempotency).
-- Historical duplicates: keep the oldest ask, clear webhook_event_id on later rows
-- without deleting work so the unique index can be created safely.

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY webhook_event_id
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM agent_work_items
  WHERE type = 'ask'
    AND webhook_event_id IS NOT NULL
)
UPDATE agent_work_items AS awi
SET
  webhook_event_id = NULL,
  updated_at = now()
FROM ranked
WHERE awi.id = ranked.id
  AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS agent_work_items_ask_webhook_event_id_uniqueness_idx
  ON agent_work_items (webhook_event_id)
  WHERE type = 'ask'
    AND webhook_event_id IS NOT NULL;
