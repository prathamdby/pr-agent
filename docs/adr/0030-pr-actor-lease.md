# ADR 0030 — PR actor lease replaces split review-slot ownership

## Status

Accepted. Amends ADR 0006 consequences (the `key_strict_fifo` / `releaseReviewQueueSlot` bullet no longer holds). Runbook: [docs/agent-work-ops.md](../agent-work-ops.md).

## Context

"One active run per PR per work type" used to be owned by three mechanisms at once: pg-boss `key_strict_fifo` queue policy with per-PR singleton keys, the `releaseReviewQueueSlot` / `reapReviewQueueOrphans` cleanup paths that reconciled pg-boss job state against `agent_work_items`, and the per-claim `execution_epoch` fencing column on `agent_work_items`. The split ownership was the debt: pg-boss job state and app-owned work-item state routinely disagreed (failed blocker jobs, orphan holders, stranded rows), so intake, cancel, and a diagnostics-tick reaper all had to repair the queue before work could proceed.

## Decision

1. **One lease table is the single authority.** `pr_actor_leases` holds one row per `(resource_key, work_type)` with a monotonic `lease_epoch`. Acquisition is a single atomic `INSERT … ON CONFLICT DO UPDATE` that succeeds when the key is unheld or lapsed and returns the new epoch as the fencing token.

2. **Lease lifecycle on the runner.** Leased work types (review, description, triage, verification) acquire the lease before claiming the work item — a delivery waiting on the lease leaves its row `queued`, so queue-rank display and stale-queued diagnostics keep their meaning — renew it on `PR_ACTOR_LEASE_RENEWAL_INTERVAL_SECONDS` while running, and release it on completion, terminal failure, retry handoff, or a failed claim. Renewal is cooperative: a lost renewal logs at warn, aborts the execution signal, and prevents the next PR-surface mutation or durable checkpoint; it never marks the item failed for a lost lease.

3. **Fencing moves to the lease epoch.** `markWork*`, `updateRunningWorkHeadSha`, `withOperationIntent`, and `recordPublishStep` fence on `(work_item_id, lease_epoch)` against `pr_actor_leases` instead of `agent_work_items.execution_epoch`. The `execution_epoch` column remains in the schema but is no longer read or written. Ask work items are unleased and pass a null fencing token; their safety continues to come from publish-record idempotency.

4. **Queues go back to `standard`.** All work queues use the pg-boss `standard` policy. Every delivery that cannot acquire the lease — whether the holder is a different work item or this item's own crashed execution — completes as a no-op after arming one throttled redelivery (`singletonKey` = work item id, `singletonSeconds`/`startAfter`: `PR_ACTOR_LEASE_DEFER_SECONDS`, `singletonNextSlot` so a re-arm is never swallowed by the firing copy's retained row). The chain re-checks the lease every defer interval until it frees or lapses, which makes it both the queued-behind path and the dead-holder watchdog: crash recovery is bounded by `PR_ACTOR_LEASE_TTL_SECONDS` plus one hop, independent of pg-boss job expiry.

5. **Intake stops repairing the queue.** Slash `/cancel`, `/review force`, close cancel, and stale-head reschedule terminalize work items and request cooperative cancellation exactly as before, but no longer find, cancel, or delete pg-boss jobs. The slot-release module, the singleton-key helpers, the stranded-work reaper, and the blocked-keys diagnostics are deleted.

6. **Migration carries the cutover.** `023_pr_actor_leases.sql` creates the table (no backfill) and flips existing deployments' leased queues to `standard` in place, because pg-boss never changes a stored policy (`createQueue` is insert-only; `updateQueue` rejects policy changes). Fresh installs skip the flip (`to_regclass` guard) and get `standard` queues at boot. Boot verifies the effective policy and logs `agent_queue_policy_mismatch` on a miss.

7. **External mutations are epoch-bound.** The worker injects the lease epoch
   and combined cancellation signal into the centralized `PrSurface` mutation
   boundary. The boundary writes an epoch-bound `operation_intents` row before
   each mutation and asserts ownership immediately before the external call.
   It also fences intent reconciliation and `publish_records` writes, so a
   renewal loss during a long remote call cannot advance stale durable state.
   Recovery workers may still use read-only surface calls to reconcile an
   ambiguous intent. Ask work remains unleased and uses its existing
   publish-record idempotency path.

## Consequences

- Crash recovery no longer needs a reaper: the watchdog deferral chain keeps re-checking until the dead holder's lease lapses, then steals it with a fresh epoch and re-executes the still-`running` item.
- Queue state can never block intake, because intake never inspects it; a terminal work item's leftover job no-ops at execution.
- Cutover is not safe with mixed old and new workers: old workers fence on queue policy while new workers fence on the lease. Drain workers before deploying, per [docs/operations.md](../operations.md). The policy flip itself is carried by migration 023, not by hand.
- The slot world's `review_queued_stale` diagnostic is replaced by a lease-aware `agent_work_queued_stale` warn (plus a `work item queued stale` PostHog event) that fires when a leased-type item sits queued past `STALE_QUEUED_WORK_GRACE_SECONDS` with no live lease row and no live pg-boss job. A waiter behind worker or group concurrency still has a `created` job and is not a dead chain. Lease health is otherwise observable through `pr_actor_lease_unavailable`, `pr_actor_lease_lost`, `pr_actor_lease_renewal_failed`, and `agent_work.lease_watchdog_arm_failed`.

## Reversal

Restore `key_strict_fifo` policies and the deleted slot/reaper modules, revert fencing to `execution_epoch`, and drop `pr_actor_leases`. Queued-behind deferrals armed before the revert complete as no-ops under either model.
