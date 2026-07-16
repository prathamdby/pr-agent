# ADR 0001 — Webhook boundary (Zod + dispatch order)

## Status

Accepted. Superseded in part by [ADR 0009](0009-durable-agent-work.md) for dedupe persistence and dispatch side effects (no installation token on the web fiber).

## Context

GitHub App webhooks are untyped JSON at the HTTP boundary. The service must validate only what each path uses, fail fast on malformed payloads, and avoid duplicate side effects when GitHub retries deliveries.

## Decision

1. **Per-event Zod schemas** live under `src/webhook/payloads/`, composed with `z.strictObject` where practical so unexpected keys signal GitHub payload drift during development.
2. **Dispatch order** is fixed: **parse + validate → (on handled events) transactional Postgres dedupe + enqueue → HTTP response**. **Ignored** `X-GitHub-Event` values record an ignored decision without enqueueing agent work. Parse failures **do not** insert a `webhook_events` row, so a retry after a transient validation error is not dropped as a “duplicate.” The web fiber does **not** mint an installation token; workers mint tokens at job execution time ([ADR 0009](0009-durable-agent-work.md)).
3. **Vitest** exercises pure seams (`verifySignature`, `parseSlashCommand`, `parseGithubPayload`, durable intake via `AgentWorkScheduler`, dispatch ordering). The legacy in-memory `DeliveryDedupe` service remains tested in isolation but is not used on the production webhook path.

## Consequences

- Adding a new webhook field requires updating the relevant Zod schema; this is intentional visibility into contract changes.
- **Durable dedupe** uses `webhook_events.dedupe_key` (`delivery:` header or `body:` SHA-256). Duplicate deliveries return **`200`** without creating duplicate work items. Intake failure returns **`503`** so GitHub may redeliver. Parse failures (`WebhookParseError`) return **`422`** and still do not insert a `webhook_events` row, so a corrected redelivery is not dropped as a duplicate.
- Worker execution remains **at-least-once**; `publish_records` and work-item status guard publish side effects under retries.

## Current implementation (2025-05)

- [`processWebhookRequestEffect`](../../src/effect/programs/processWebhookRequestEffect.ts): signature verification, parse, then current dispatch to `WebhookHandlers` and `AgentWorkScheduler`.
- [`makeAgentWorkScheduler`](../../src/agentWork/scheduler.ts): `INSERT … ON CONFLICT (dedupe_key) DO NOTHING` in the same transaction as work-item creation and pg-boss enqueue.

## Reversal

Changing the boundary (e.g. replacing Zod, moving parse after dedupe, or returning to in-memory dedupe) should be discussed explicitly because it affects correctness under retries and load-balanced deployments.
