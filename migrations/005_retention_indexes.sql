CREATE INDEX IF NOT EXISTS agent_work_items_status_completed_at_idx
  ON agent_work_items (status, completed_at);
