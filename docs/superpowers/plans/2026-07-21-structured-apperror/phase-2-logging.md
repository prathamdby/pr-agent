# Phase 2 — Log serialization

Back: [overview.md](./overview.md)

## Goal

Durable-job and related `logError` failure paths include serialized AppError
fields without changing the `logError` call signature for unrelated events.

## Changes

- Add a small helper used at failure sites (e.g. `errorLogFields(error)`) that
  merges `serializeAppError` when applicable.
- Update `durableJob` `agent_work_failed` logging (and similar failure logs) to
  include `errorCode`, `errorContext`, cause summary.
- Keep `last_error` DB column as sanitized message string only.

## Data structures

Log meta keys: `errorCode`, `errorContext`, `errorCause` (optional nested).

## Verification

Unit/integration tests covering durable failure logging if present; otherwise
assert via existing agent-work tests still green.
