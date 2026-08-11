# ADR 0009 — Durable agent work queue

## Status

Accepted. Operator-facing summary: [README.md](../../README.md) (How it works, Host with Docker Compose). Runbooks: [docs/agent-work-ops.md](../agent-work-ops.md).

## Context

GitHub requires webhook handlers to respond within 10 seconds. The old review path accepted a webhook and then owned the full LLM review on the request fiber. The in-memory `ReviewQueue` and `AskQueue` only capped process-local concurrency; they did not persist intake, survive restarts, dedupe deliveries durably, supervise worker lifecycle, or preserve ask capacity during a review burst.

Production failures during small bursts showed that webhook acknowledgement, GitHub PR-surface I/O, and long LLM work were too tightly coupled.

## Decision

1. **Durable intake** — Webhook dispatch records `webhook_events`, `agent_work_items`, and pg-boss jobs in one Postgres transaction. The HTTP response is sent only after the transaction commits.

2. **Postgres + pg-boss** — Use Postgres for app-owned workflow state and pg-boss for delivery, retries, heartbeat, expiration, dead-letter retention, and per-key queue policy.

3. **Web/worker split** — `ROLE=web` serves `/health`, `/ready`, and `/webhooks`. `ROLE=worker` runs acknowledgement, CI-refresh, review, ask, description, triage, verification, and retention workers from the same image.

4. **No PR-surface I/O on webhook fibers** — GitHub reactions, progress comments, ask replies, inline reviews, labels, and failure notices run in worker jobs. Webhook fibers verify, parse, dedupe, commit, enqueue, and return.

5. **Review progress comment lifecycle** — A high-priority acknowledgement job posts 👀 reactions and a minimal progress comment identified by the review summary sentinel. Review completion, reruns, terminal failures, and structured-publish fallback edit the same comment. Terminal success/failure also replace the acknowledgement reaction with 👍 / 👎 on the ack targets.

6. **Fresh token execution** — Jobs store `installationId`; workers mint installation tokens immediately before GitHub operations.

7. **Superseding and lanes** — Automated reviews use latest-head-wins semantics for the same PR. `/ask` uses a separate queue and reserved worker capacity. [ADR 0028](0028-orchestrated-review.md) replaced per-lens singleton keys and progress comments with one active review slot per pull request.

8. **Publish idempotency** — `publish_records` tracks progress comments, inline review publishing, summary comments, and label sync so at-least-once job execution can resume safely.

## Consequences

- GitHub may redeliver if Postgres is unavailable during intake because the app returns `503` instead of acknowledging unpersisted work.
- Acknowledgement reactions and progress comments are fast but asynchronous; they may appear shortly after the webhook response.
- `key_strict_fifo` blocks a pull request while a pg-boss review job is failed or an orphan holder remains. `releaseReviewQueueSlot` clears failed blockers and jobs for missing/terminal work items on intake, cancel, and the diagnostics tick; worker logs still expose blocked keys and `docs/agent-work-ops.md` documents manual recovery.
- ADR 0002's in-memory queue decision and ADR 0007's "synchronous webhook contract unchanged" consequence are superseded for agent work.

## Reversal

The change is reversible by routing `WebhookHandlers` back through `ReviewQueue`/`AskQueue` and disabling `ROLE=worker`, but that reintroduces request-fiber-owned reviews and non-durable delivery.
