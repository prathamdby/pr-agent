-- Durable ask admission state. Bucket rows are scoped to one installation,
-- repository within an installation, or actor within an installation.
CREATE TABLE IF NOT EXISTS ask_quota_buckets (
  scope text NOT NULL CHECK (scope IN ('actor', 'repository', 'installation')),
  scope_key text NOT NULL,
  token_balance double precision NOT NULL CHECK (token_balance >= 0),
  last_refill_at timestamptz NOT NULL DEFAULT now(),
  outstanding_count integer NOT NULL DEFAULT 0 CHECK (outstanding_count >= 0),
  provider_tokens_used bigint NOT NULL DEFAULT 0 CHECK (provider_tokens_used >= 0),
  provider_tokens_reserved bigint NOT NULL DEFAULT 0 CHECK (provider_tokens_reserved >= 0),
  provider_window_started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, scope_key)
);

CREATE INDEX IF NOT EXISTS ask_quota_buckets_updated_at_idx
  ON ask_quota_buckets (updated_at);

CREATE TABLE IF NOT EXISTS ask_quota_reservations (
  work_item_id uuid PRIMARY KEY
    REFERENCES agent_work_items(id) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED,
  actor_scope_key text NOT NULL,
  repository_scope_key text NOT NULL,
  installation_scope_key text NOT NULL,
  reserved_provider_tokens bigint NOT NULL DEFAULT 0 CHECK (reserved_provider_tokens >= 0),
  provider_usage_known boolean NOT NULL DEFAULT false,
  provider_tokens_used bigint NOT NULL DEFAULT 0 CHECK (provider_tokens_used >= 0),
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ask_quota_reservations_active_idx
  ON ask_quota_reservations (released_at)
  WHERE released_at IS NULL;

-- Count asks that were already active when this migration was installed. Old
-- rows do not have provider reservations because their admission was pre-quota.
WITH active_asks AS (
  SELECT
    id,
    installation_id,
    owner,
    repo,
    payload->>'commenterId' AS commenter_id
  FROM agent_work_items
  WHERE type = 'ask'
    AND status IN ('queued', 'running')
    AND payload->>'commenterId' ~ '^[0-9]+$'
),
reservations AS (
  INSERT INTO ask_quota_reservations (
    work_item_id,
    actor_scope_key,
    repository_scope_key,
    installation_scope_key
  )
  SELECT
    id,
    'actor:' || installation_id || ':' || commenter_id,
    'repository:' || installation_id || ':' || lower(owner) || '/' || lower(repo),
    'installation:' || installation_id
  FROM active_asks
  ON CONFLICT (work_item_id) DO NOTHING
  RETURNING work_item_id
)
INSERT INTO ask_quota_buckets (
  scope,
  scope_key,
  token_balance,
  last_refill_at,
  outstanding_count,
  provider_window_started_at
)
SELECT scope, scope_key, 0, to_timestamp(0), COUNT(*)::integer, now()
FROM (
  SELECT 'actor'::text AS scope,
         'actor:' || installation_id || ':' || commenter_id AS scope_key
  FROM active_asks
  UNION ALL
  SELECT 'repository'::text,
         'repository:' || installation_id || ':' || lower(owner) || '/' || lower(repo)
  FROM active_asks
  UNION ALL
  SELECT 'installation'::text,
         'installation:' || installation_id
  FROM active_asks
) scopes
GROUP BY scope, scope_key
ON CONFLICT (scope, scope_key) DO NOTHING;

CREATE OR REPLACE FUNCTION release_ask_quota_reservation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  reservation ask_quota_reservations%ROWTYPE;
  provider_charge bigint;
BEGIN
  IF OLD.status IN ('queued', 'running')
     AND NEW.status IN ('superseded', 'cancelled', 'completed', 'failed') THEN
    SELECT *
      INTO reservation
      FROM ask_quota_reservations
     WHERE work_item_id = NEW.id
     FOR UPDATE;

    IF FOUND AND reservation.released_at IS NULL THEN
      provider_charge := CASE
        WHEN reservation.provider_usage_known THEN 0
        ELSE reservation.reserved_provider_tokens
      END;

      UPDATE ask_quota_reservations
         SET released_at = clock_timestamp(),
             reserved_provider_tokens = 0,
             updated_at = clock_timestamp()
       WHERE work_item_id = NEW.id;

      -- Keep the update order aligned with admission (installation, repository,
      -- actor) so a terminal worker cannot deadlock a concurrent intake.
      UPDATE ask_quota_buckets
         SET outstanding_count = GREATEST(0, outstanding_count - 1),
             provider_tokens_reserved = GREATEST(
               0, provider_tokens_reserved - reservation.reserved_provider_tokens
             ),
             provider_tokens_used = provider_tokens_used + provider_charge,
             updated_at = clock_timestamp()
       WHERE scope = 'installation'
         AND scope_key = reservation.installation_scope_key;

      UPDATE ask_quota_buckets
         SET outstanding_count = GREATEST(0, outstanding_count - 1),
             updated_at = clock_timestamp()
       WHERE scope = 'repository'
         AND scope_key = reservation.repository_scope_key;

      UPDATE ask_quota_buckets
         SET outstanding_count = GREATEST(0, outstanding_count - 1),
             updated_at = clock_timestamp()
       WHERE scope = 'actor'
         AND scope_key = reservation.actor_scope_key;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_work_items_release_ask_quota ON agent_work_items;
CREATE TRIGGER agent_work_items_release_ask_quota
  AFTER UPDATE OF status ON agent_work_items
  FOR EACH ROW
  EXECUTE FUNCTION release_ask_quota_reservation();
