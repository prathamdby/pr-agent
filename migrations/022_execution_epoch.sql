-- Monotonic fencing token per work-item execution. Existing in-flight rows
-- start at 0; the next claim takes epoch 1.
ALTER TABLE agent_work_items
  ADD COLUMN IF NOT EXISTS execution_epoch bigint NOT NULL DEFAULT 0;
