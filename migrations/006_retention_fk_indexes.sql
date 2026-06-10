CREATE INDEX IF NOT EXISTS agent_work_items_webhook_event_id_idx
  ON agent_work_items (webhook_event_id)
  WHERE webhook_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS publish_records_work_item_id_idx
  ON publish_records (work_item_id);

CREATE INDEX IF NOT EXISTS agent_work_items_status_retention_age_idx
  ON agent_work_items (status, (COALESCE(completed_at, updated_at)));

DROP INDEX IF EXISTS agent_work_items_status_idx;
DROP INDEX IF EXISTS agent_work_items_status_completed_at_idx;
DROP INDEX IF EXISTS agent_work_items_installation_status_idx;
