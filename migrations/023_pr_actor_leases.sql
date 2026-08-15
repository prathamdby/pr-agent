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

-- pg-boss never changes an existing queue's policy: createQueue is insert-only
-- and updateQueue throws on policy changes, so the key_strict_fifo -> standard
-- flip for existing deployments happens here, while old workers are drained.
-- Fresh installs have no pgboss schema at migration time (migrations run before
-- boss start); their queues are created with the standard policy at boot.
DO $$
BEGIN
  IF to_regclass('pgboss.queue') IS NOT NULL THEN
    UPDATE pgboss.queue
       SET policy = 'standard'
     WHERE name IN ('agent-work-review', 'agent-work-description', 'agent-work-triage', 'agent-work-verification')
       AND policy <> 'standard';
  END IF;
END $$;
