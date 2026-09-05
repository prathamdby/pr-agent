# ADR 0031 — Durable ask admission quotas

## Status

Accepted.

## Context

Allowed comment authors can create distinct `/ask` or `@bot` deliveries faster
than the ask worker can execute them. A queue concurrency setting limits active
execution, but it does not bound durable backlog or provider spend across
workers, repositories, or installations.

## Decision

1. Shared ask intake performs admission before inserting an ask work item. It
   runs in the same Postgres transaction as webhook dedupe, work-item insert,
   acknowledgement enqueue, and ask enqueue.
2. Admission locks one durable token bucket for each actor, repository, and
   installation. It checks outstanding work before rate capacity, in the order
   actor, repository, installation. Bucket rows use a fixed lock order to avoid
   cross-scope deadlocks.
3. An admitted ask creates one quota reservation. A database trigger releases
   the actor, repository, and installation outstanding counts when the ask
   becomes completed, failed, cancelled, or superseded. Retry transitions stay
   outstanding.
4. When an installation provider token budget is enabled, intake reserves a
   configured maximum per ask. Exact Pi usage replaces that reservation. If the
   provider reports no usage, the reservation is charged at its maximum so an
   unknown result cannot reopen budget capacity without accounting. The
   installation window resets on elapsed wall-clock time regardless of
   outstanding reservations. A reservation that straddles the reset stays
   reserved against the new window and is never charged to two windows.
5. Known provider usage is keyed by a server-owned execution id for one
   model-backed ask computation, not by work-item id or claim attempt count.
   Replaying the same receipt is a no-op. A new computation after retry writes a
   new receipt and adds its tokens. Conflicting finals for one execution are an
   accounting error and leave the prior charge unchanged. Reservation conversion
   happens once; later receipts add usage only. A delayed valid receipt after
   terminal release does not reopen outstanding work. If the terminal trigger
   already charged unknown usage in the current window, the first receipt
   replaces that stand-in. Receipts that arrive after the window resets do not
   move that settled charge into the new window. Existing `provider_tokens_used`
   values remain the upgrade baseline. The migration does not invent historical
   execution rows. Receipts store only work-item id, execution id, and tokens.
   They cascade when the work item is deleted.
6. A rejected ask creates no work item or ask queue job. Intake sends a static
   reply through the high-priority acknowledgement queue. Quota bucket state is
   retained in Postgres and inactive rows are removed by the normal retention
   sweep.

## Consequences

- Concurrent web replicas share one admission state and cannot race around a
  configured limit.
- Review, triage, and acknowledgement lanes remain independent from throttled
  asks. Ask execution remains unleased; publish-record idempotency still owns
  its worker recovery.
- Provider budgets are token budgets, not billing guarantees. They are enforced
  only from usage metadata exposed by the Pi seam and use the reservation cap
  when that metadata is unavailable.

## Reversal

Remove the ask quota migration, trigger, admission calls, provider usage
reconciliation, and the documented `ASK_*` quota settings. Restore direct ask
work-item insertion in the shared intake path.
