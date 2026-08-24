-- Bind every leased PR-surface intent and publish ledger row to the epoch that
-- was allowed to perform it. Null remains the explicit value for unleased ask
-- and auxiliary writers.
ALTER TABLE operation_intents
  ADD COLUMN IF NOT EXISTS lease_epoch bigint;

ALTER TABLE publish_records
  ADD COLUMN IF NOT EXISTS lease_epoch bigint;

CREATE INDEX IF NOT EXISTS operation_intents_work_item_lease_epoch_idx
  ON operation_intents (work_item_id, lease_epoch);

CREATE INDEX IF NOT EXISTS publish_records_work_item_lease_epoch_idx
  ON publish_records (work_item_id, lease_epoch);
