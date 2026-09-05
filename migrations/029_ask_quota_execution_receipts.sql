-- Per-computation usage receipts. Existing ask_quota_buckets.provider_tokens_used
-- and reservation.provider_tokens_used stay as the upgrade baseline. This
-- migration does not invent historical execution rows for charges already applied.
ALTER TABLE ask_quota_reservations
  ADD COLUMN IF NOT EXISTS unknown_usage_charged bigint NOT NULL DEFAULT 0
    CHECK (unknown_usage_charged >= 0),
  ADD COLUMN IF NOT EXISTS unknown_usage_window_started_at timestamptz;

CREATE TABLE IF NOT EXISTS ask_quota_execution_receipts (
  work_item_id uuid NOT NULL
    REFERENCES ask_quota_reservations(work_item_id) ON DELETE CASCADE,
  execution_id uuid NOT NULL,
  provider_tokens_used bigint NOT NULL CHECK (provider_tokens_used >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (work_item_id, execution_id)
);

CREATE OR REPLACE FUNCTION release_ask_quota_reservation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  reservation ask_quota_reservations%ROWTYPE;
  provider_charge bigint;
  charged_window timestamptz;
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

      IF provider_charge > 0 THEN
        SELECT provider_window_started_at
          INTO charged_window
          FROM ask_quota_buckets
         WHERE scope = 'installation'
           AND scope_key = reservation.installation_scope_key;
      END IF;

      UPDATE ask_quota_reservations
         SET released_at = clock_timestamp(),
             reserved_provider_tokens = 0,
             unknown_usage_charged = provider_charge,
             unknown_usage_window_started_at = charged_window,
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
