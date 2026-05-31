CREATE INDEX IF NOT EXISTS agent_work_items_superseded_by_idx
  ON agent_work_items (superseded_by);

CREATE INDEX IF NOT EXISTS agent_work_items_resource_type_status_idx
  ON agent_work_items (resource_key, type, status);
