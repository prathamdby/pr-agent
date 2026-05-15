# ADR 0001 — Webhook boundary (Zod + dispatch order)

## Status

Accepted.

## Context

GitHub App webhooks are untyped JSON at the HTTP boundary. The service must validate only what each path uses, fail fast on malformed payloads, and avoid duplicate side effects when GitHub retries deliveries.

## Decision

1. **Per-event Zod schemas** live under `src/webhook/payloads/`, composed with `z.strictObject` where practical so unexpected keys signal GitHub payload drift during development.
2. **Dispatch order** is fixed: **parse + validate → dedupe → (if event is handled) installation token → handlers**. **Ignored** `X-GitHub-Event` values skip the token call—no handler runs, so minting an installation token would only add latency and failure modes (e.g. local smoke tests without real GitHub credentials). Parse failures **do not** consume the in-memory dedupe slot, so a retry after a transient validation error is not dropped as a “duplicate.”
3. **Vitest** exercises pure seams (`deliveryDedupe`, `verifySignature`, `parseSlashCommand`, `parseGithubPayload`, dispatch ordering).

## Consequences

- Adding a new webhook field requires updating the relevant Zod schema; this is intentional visibility into contract changes.
- **In-memory dedupe** is per process and marks a delivery **before** the handler finishes. If the handler throws after dedupe, a retry with the same `X-GitHub-Delivery` may still be suppressed; improving that (e.g. commit dedupe only after success) is a separate change. Multiple replicas can each process the same delivery once; operators should assume at-least-once semantics at the webhook level.

## Reversal

Changing the boundary (e.g. replacing Zod, moving parse after dedupe, or shared cross-process dedupe) should be discussed explicitly because it affects correctness under retries and load-balanced deployments.
