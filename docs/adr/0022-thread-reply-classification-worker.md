# ADR 0022 — Asynchronous thread-reply classification

## Status

Accepted.

## Context

When `ENABLE_THREAD_REPLIES=true`, a non-slash reply in a bot inline review thread becomes an implicit `/ask`. Classification previously ran on the webhook request fiber: mint an installation token, fetch the parent review comment, and resolve the app bot identity ([ADR 0009](0009-durable-agent-work.md) point 4 forbids PR-surface I/O on webhook fibers). Under GitHub’s ~10s webhook deadline, a slow or rate-limited API call could exhaust the budget and return 503 for work that should acknowledge in milliseconds.

Storing `pull_request_review_id` in `publish_records` alone cannot cover legacy comments, overwritten publish rows, or the publish crash window where the parent is still bot-authored but not yet durable in Postgres. The bot-author fallback must remain available.

## Decision

1. **Web path is DB-only (plus association).** For non-slash `pull_request_review_comment` replies, the web role applies the slash-association allowlist (payload-only; no PR-surface I/O), may look up a stored inline review id as a hint, then insert `webhook_events` with `thread_reply_classification_queued` and enqueue `agent-work-thread-classify` in the same Postgres transaction (`pgBossDb(client)`). It must not call `mintInstallationAuth`, `getPullRequestReviewComment`, `getAppBotIdentity`, or bot-commenter suppression. Slash-command intake is unchanged.
2. **Worker classifies.** The classify job carries event/correlation/install/repo/PR/comment/body/reply-target/code-anchor data and the optional stored-review hint. The worker resolves bot identity and commenter suppression; treats a true stored-review hint as bot-thread without repeating review-record or parent lookup; otherwise falls back to `publish_records` and GitHub parent-user / review-id predicates. Association is rechecked for defense.
3. **Idempotent promotion.** Under `webhook_events … FOR UPDATE`, terminal decisions return without re-work. Positive classification parses the implicit ask, creates or loads exactly one ask by `webhook_event_id` (partial unique index from migration `015`), always enqueues ack+ask for that ask id while the event is still queued (or usage/too-long ack only) via the transaction-bound adapter, then marks `thread_reply_ask_enqueued`. A missing webhook event throws so the job retries/DLQs. Negatives are `ignored_non_bot_thread_reply`, `ignored_bot_slash_command`, or `ignored_unauthorized_slash`. Final pg-boss exhaustion records `thread_reply_classification_failed` (sanitized error) and relies on the DLQ.
4. **Rollout order.** Deploy workers that consume `agent-work-thread-classify` before web instances that enqueue it (`THREAD_REPLY_CLASSIFY_CONCURRENCY`, default 2).

## Consequences

- Webhook latency for thread replies no longer depends on GitHub API latency.
- Classification is at-least-once; duplicate classify jobs cannot duplicate ask/ack work because of the event lock, unique ask index, and terminal decision gate.
- Operators must roll workers before web during the first deploy that introduces the queue.

## Reversal

Restore synchronous `matchesStoredInlineReview` GitHub calls on the webhook fiber and stop enqueueing `agent-work-thread-classify` (not recommended).
