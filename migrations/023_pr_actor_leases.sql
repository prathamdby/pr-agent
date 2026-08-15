-- One leased row per (resource_key, work_type) is the single authority on who
-- may execute and publish for a pull request. Rows are never deleted: release
-- clears the holder in place so lease_epoch stays monotonic and fencing sound.
CREATE TABLE IF NOT EXISTS pr_actor_leases (
  resource_key   text        NOT NULL,
  work_type      text        NOT NULL,
  lease_epoch    bigint      NOT NULL DEFAULT 0,
  work_item_id   uuid        NULL,
  holder_id      text        NULL,
  acquired_at    timestamptz NULL,
  renewed_at     timestamptz NULL,
  expires_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (resource_key, work_type)
);
