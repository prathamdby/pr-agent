# Phase 3 — Migrate throws

Back: [overview.md](./overview.md)

## Goal

Every production `throw new Error(...)` in `src/` becomes `AppError` (or a
domain subclass of it). Preserve messages and `instanceof` behavior.

## Changes

- Fold `WebhookParseError`, `StaleHeadPushError`,
  `WorkItemPayloadValidationError` to extend `AppError`.
- Convert bare throws by area: config/settings, agentWork, review, agent/*,
  prWorkspace, github, providers, posthog init guard.
- Document the format in `docs/development.md`.

## Data structures

Codes use `<domain>.<reason_snake>`. Context holds the identifying fields
already interpolated into messages (ids, paths, env names) as structured keys.

## Verification

Full `nub run test` and `nub run check:code`. Grep for remaining
`throw new Error` in `src/` (allow only if justified and documented; prefer zero).
