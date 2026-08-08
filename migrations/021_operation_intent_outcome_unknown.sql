-- Split "clean mutate throw" (failed, retryable) from "may have already mutated"
-- (outcome_unknown, never auto-retried).
ALTER TABLE operation_intents DROP CONSTRAINT IF EXISTS operation_intents_status_check;
ALTER TABLE operation_intents
  ADD CONSTRAINT operation_intents_status_check
  CHECK (status IN ('pending', 'reconciled', 'failed', 'outcome_unknown'));
