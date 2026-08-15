# ADR 0038 — PR actor lease replaces split review-slot ownership

## Status

Accepted. Amends ADR 0009 consequences (the `key_strict_fifo` / `releaseReviewQueueSlot` bullet no longer holds). Runbook: [docs/agent-work-ops.md](../agent-work-ops.md).

## Context

"One active run per PR per work type" used to be owned by three mechanisms at once: pg-boss `key_strict_fifo` queue policy with per-PR singleton keys, the `releaseReviewQueueSlot` / `reapReviewQueueOrphans` cleanup paths that reconciled pg-boss job state against `agent_work_items`, and the per-claim `execution_epoch` fencing column on `agent_work_items`. The split ownership was the debt: pg-boss job state and app-owned work-item state routinely disagreed (failed blocker jobs, orphan holders, stranded rows), so intake, cancel, and a diagnostics-tick reaper all had to repair the queue before work could proceed.

## Decision

1. **One lease table is the single authority.** `pr_actor_leases` holds one row per `(resource_key, work_type)` with a monotonic `lease_epoch`. Acquisition is a single atomic `INSERT … ON CONFLICT DO UPDATE` that succeeds when the key is unheld or lapsed and returns the new epoch as the fencing token.

2. **Lease lifecycle on the runner.** Leased work types (review, description, triage, verification) acquire the lease after claiming the work item, renew it on `PR_ACTOR_LEASE_RENEWAL_INTERVAL_SECONDS` while running, and release it on completion, terminal failure, or retry handoff. Renewal is cooperative: a lost renewal logs at warn and the holder stops at its next fencing checkpoint; it never marks the item failed for a lost lease.

3. **Fencing moves to the lease epoch.** `markWork*`, `updateRunningWorkHeadSha`, `withOperationIntent`, and `recordPublishStep` fence on `(work_item_id, lease_epoch)` against `pr_actor_leases` instead of `agent_work_items.execution_epoch`. The `execution_epoch` column remains in the schema but is no longer read or written. Ask work items are unleased and pass a null fencing token; their safety continues to come from publish-record idempotency.

4. **Queues go back to `standard`.** All work queues use the pg-boss `standard` policy. A delivery that cannot acquire the lease completes as a no-op; when a different work item holds the lease it arms one deferred redelivery (deterministic uuidv5 job id over the work item id and observed epoch, `startAfter: PR_ACTOR_LEASE_DEFER_SECONDS`) so queued-behind work retries acquisition instead of stranding.

5. **Intake stops repairing the queue.** Slash `/cancel`, `/review force`, merge cancel, and stale-head reschedule terminalize work items and request cooperative cancellation exactly as before, but no longer find, cancel, or delete pg-boss jobs. The slot-release module, the singleton-key helpers, the stranded-work reaper, and the blocked-keys diagnostics are deleted.

6. **Migration is additive only.** `023_pr_actor_leases.sql` creates the table; there is no backfill.

## Consequences

- Crash recovery no longer needs a reaper: pg-boss redelivers the expired job and the lapsed lease is stolen by the next delivery with a fresh epoch.
- Queue state can never block intake, because intake never inspects it; a terminal work item's leftover job no-ops at execution.
- Cutover is not safe with mixed old and new workers: old workers fence on queue policy while new workers fence on the lease. Drain workers before deploying, per [docs/operations.md](../operations.md).
- The `review_queued_stale` diagnostic and `STRANDED_WORK_REAPER_*` constants are gone; lease health is observable through `pr_actor_lease_unavailable`, `pr_actor_lease_lost`, and `pr_actor_lease_renewal_failed` log events.

## Reversal

Restore `key_strict_fifo` policies and the deleted slot/reaper modules, revert fencing to `execution_epoch`, and drop `pr_actor_leases`. Queued-behind deferrals armed before the revert complete as no-ops under either model.
