# ADR 0001 — Webhook boundary (Valibot + dispatch order)

## Status

Accepted. Superseded in part by [ADR 0009](0009-durable-agent-work.md) for dedupe persistence and dispatch side effects (no installation token on the web fiber). Validation library is Valibot ([ADR 0035](0035-replace-zod-with-valibot.md)).

## Context

GitHub App webhooks are untyped JSON at the HTTP boundary. The service must validate only what each path uses, fail fast on malformed payloads, and avoid duplicate side effects when GitHub retries deliveries.

## Decision

1. **Per-event Valibot schemas** live under `src/webhook/payloads/`, composed with `v.object` so each event type admits only the fields that path uses.
2. **Dispatch order** is fixed: **verify the raw body → parse + validate → transactional Postgres delivery dedupe, body-hash replay reservation, and enqueue → HTTP response**. **Ignored** `X-GitHub-Event` values record an ignored decision without enqueueing agent work, but still consume the bounded body-hash replay window. Parse failures **do not** insert a `webhook_events` or `webhook_event_replays` row, so a retry after a transient validation error is not dropped as a “duplicate.” The web fiber does **not** mint an installation token; workers mint tokens at job execution time ([ADR 0009](0009-durable-agent-work.md)).
3. **Vitest** exercises pure seams (`verifySignature`, `parseSlashCommand`, `parseGithubPayload`, durable intake via `AgentWorkScheduler`, dispatch ordering).

## Consequences

- Adding a new webhook field requires updating the relevant Valibot schema; this is intentional visibility into contract changes.
- **Durable dedupe** keeps `webhook_events.dedupe_key` for delivery-ID correlation and uses the unique `webhook_event_replays.body_sha256` row as an independent replay key. Replay rows reference their event and expire with `WEBHOOK_EVENTS_RETENTION_SECONDS` (30 days by default). Duplicate deliveries return **`200`** without creating duplicate work items. Intake failure returns **`503`** so GitHub may redeliver; transaction rollback removes the replay reservation. Parse failures (`WebhookParseError`) return **`422`** and still do not insert either durable dedupe row, so a corrected redelivery is not dropped as a duplicate.
- Worker execution remains **at-least-once**; `publish_records` and work-item status guard publish side effects under retries.

## Current implementation

- [`processWebhookRequestEffect`](../../src/effect/programs/processWebhookRequestEffect.ts): signature verification, parse, then current dispatch to `WebhookHandlers` and `AgentWorkScheduler`.
- [`makeAgentWorkScheduler`](../../src/agentWork/scheduler.ts): delivery-event insertion, body-hash replay reservation, work-item creation, and pg-boss enqueue share one transaction.

## Reversal

Changing the boundary (replacing Valibot, moving parse after dedupe, or returning to in-memory dedupe) should be discussed explicitly because it affects correctness under retries and load-balanced deployments.
