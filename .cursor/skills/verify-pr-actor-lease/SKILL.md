---
name: verify-pr-actor-lease
description: >
  Check the PR actor lease and the fenced GitHub publish path. Use when a
  change touches acquire, renew, release, cancel or supersede of
  pr_actor_leases, the pre-HTTP lease check, publishOnce, or operation
  intent identity. Runs TLC on the model of one lease per resource and
  work type.
---

# Verify the PR actor lease

One `pr_actor_leases` row per resource key and work type is the only holder. A worker whose epoch is no longer that row must not commit a durable publish. Two work items for that same row send at most one GitHub mutation for the in-flight intent. This skill checks those three claims. They hold on this checkout. `NoStaleDurable` still fails when the fence constant is off.

The command is one process. Run it from the repo root.

```bash
node .cursor/skills/verify-pr-actor-lease/check.mjs
```

It needs `java` and `curl`. It downloads TLC 2.19, the jar from TLA+ release v1.7.4, and checks sha256 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`. A matching jar in the temp directory is reused.

Exit 0 means the source anchors still match the model and TLC reports the same split. Safety passes. `AtMostOneGithubSend` passes for expiry and for supersede. `NoStaleDurable` fails when the fence constant is off.

## When a change is in scope

Read the diff. Run the command if it touches any of these.

- `src/agentWork/prActorLease.ts` acquires, renews, and clears the row.
- `src/agentWork/leasedExecution.ts` claims inside the acquire transaction, renews on a timer, and checks the lease before `mutate()`.
- `src/github/prSurfaceMutation.ts` checks the abort signal and then calls the GitHub method.
- `src/agentWork/publishOnce.ts` writes `__mutating` and then calls `mutate()`. `recordPublishStep` fences the publish row.
- `src/agentWork/operationIntentRepository.ts` fences `reconcileOperationIntent`.
- `migrations/016_agent_runtime_durability.sql` defines `UNIQUE (work_item_id, operation_key)`.
- `src/review/publish/publishSummaryOnly.ts` builds the summary marker from the work item id.
- `src/github/reviewPublish.ts` issues the GitHub call with no abort signal.
- `src/settings/reviewConstants.ts` holds `REVIEW_SUMMARY_SENTINEL`.

A change that only renames a local variable outside those snippets is out of scope. Run the command anyway if you are unsure. The anchor failure names the snippet.

## What the model is

`PrActorLease.tla` is the model. Workers are `w1` on work item `i1`, `w2` on `i2`, and `r1` on `i1` again. One lease row. Epochs stop at 3. Expiry is a boolean. These are the steps. Each one is one step in the code.

| Model step        | Code                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Acquire`         | `acquirePrActorLease`. One `INSERT ... ON CONFLICT DO UPDATE`. `claimWorkForExecution` runs in that same transaction, so `Acquire` includes the claim. Claim passes `executionEpoch`, and `transition` adds the lease `EXISTS` fragment only when that field is omitted, so the claim statement does not re-read the lease. The open transaction's row lock is the fence. |
| `Expire`          | `expires_at <= now()`. `AllowExpire` turns this off in `supersede.cfg`.                                                                                                                                                                                                                                                                                                   |
| `Renew`           | `renewPrActorLease`. Matches epoch and `work_item_id`. The `WHERE` clause does not read `expires_at`.                                                                                                                                                                                                                                                                     |
| `CancelClear`     | `releasePrActorLeaseHeldByWorkItems`. Clears the holder. Does not bump `lease_epoch`. Callers include `supersedeActiveAutoWork` and `cancelActiveReviews`.                                                                                                                                                                                                                |
| `ObserveLoss`     | `startCancelObserve`, and `onLost` after a renew that returns false. The SQL error callback logs `pr_actor_lease_renewal_failed` and does not call `onLost`.                                                                                                                                                                                                              |
| `MarkMutating`    | `mergeOperationIntentDetail` sets `__mutating` before the GitHub call. The `EXISTS` check reads `expires_at > now()`.                                                                                                                                                                                                                                                     |
| `RecoverInFlight` | `findInFlightMutatingIntent` selects one pending `__mutating` row for the resource and work type. The operation key may differ. `publishOnceBody` recovers that row and does not call `mutate()`.                                                                                                                                                                         |
| `Arm`             | `assertPrActorLeaseHeld` in `createLeaseMutationBoundary`. `isPrActorLeaseHeld` matches work item, epoch, and `expires_at > now()`.                                                                                                                                                                                                                                       |
| `AbortGate`       | `throwIfAborted` in `withPrSurfaceMutationBoundary`, then `confirmLeaseHeld`, then the GitHub call. A send requires `Held`.                                                                                                                                                                                                                                               |
| `Reconcile`       | `reconcileOperationIntent` and `recordPublishStep`. Both use `Held`, including `expires_at > now()`. With `FenceOn`, the write commits only while `Held` is true.                                                                                                                                                                                                         |
| `Release`         | `releasePrActorLease`. Matches `lease_epoch` only. A stale epoch changes zero rows.                                                                                                                                                                                                                                                                                       |
| `Pause`           | A TLC stutter so a finished state has a successor. No worker runs this step.                                                                                                                                                                                                                                                                                              |

`Held` is `isPrActorLeaseHeld`. An expired row is not held. `Reconcile` uses that same `Held`.

## How to read the result

The command prints four lines.

`safety passed` means TLC finished `safety.cfg` with no invariant failure. The invariants are `TypeOk`, `OneHolder`, `AtMostOneSendPerWorkItem`, `SendImpliesIntent`, and `NoStaleDurable`. The temporal check is `MonotonicEpoch`. `FenceOn` and `AllowExpire` are true. The command prints the distinct-state count for that finite model. It is not a count of production schedules outside the bound.

`exactly-once passed` is the expiry config. `supersede passed` is the same invariant with `AllowExpire` false, so the handoff is `CancelClear` only. `AtMostOneGithubSend` holds on both. The full state list is the `tlc.txt` path the command prints.

`broken-fence violated NoStaleDurable` is the model with `FenceOn` false. It must keep failing. A check that cannot fail does not prove the fence.

Replay a trace against the table above before you call it a product bug. Walk each state in order. If one step cannot happen in the code, the model is wrong. Fix the model or the anchor, then run the command again. If every step can happen, the invariant failure is a bug in the product. Do not weaken the invariant, delete a worker, or turn off `Expire` in `exactly-once.cfg` to make that finding disappear.

`AtMostOneGithubSend` stays in `exactly-once.cfg` and `supersede.cfg`. Do not delete the invariant to get a green command. A checkout that violates it exits 1.

An anchor failure means the snippet the model names has moved. Read the current function and update the model so the step still matches the code. Then update the snippet in `check.mjs`. Run the command. A pass after that edit is not evidence until `broken-fence.cfg` still violates `NoStaleDurable`.

## The send the model allows

`AtMostOneGithubSend` says the two work items together send a GitHub mutation at most once. A send in `AbortGate` requires `Held` after `throwIfAborted`. `Held` is false when the row is expired or the holder changed.

`w1` can write `__mutating` and reach `Arm`. `CancelClear` or `Expire` then makes `Held` false. `AbortGate` does not send. `w2` acquires the next epoch, sees the resource `__mutating` flag, and takes `RecoverInFlight`. It does not send. `deterministicInlineBatchId` still includes `workItemId`, so the two operation keys differ. The lookup does not require those keys to be equal.

`operation_intents` stays unique on `(work_item_id, operation_key)`. The in-flight row is the other work item's row. Recovery writes that row under the successor's lease.

Durable reconcile does not commit for a stale or expired epoch while `FenceOn` is true. `NoStaleDurable` passing is that claim. The GitHub call is the step before it, and that step also requires `Held`.

## After an intentional change

1. Run the command on the unchanged model. Read which line failed.
2. Change `PrActorLease.tla` so each changed product step is still one model step. Do this from the code, not from the TLC result you want.
3. If the product promise changed, write the old invariant, the new invariant, and the evidence (the doc, the test, or the commit message) into this file. A missing `EXISTS` clause is not a promise change by itself.
4. Run the command. `broken-fence.cfg` must still violate `NoStaleDurable`.
5. Move the sync commit below only after that run describes the code at the new commit. Leave the commit where it is if the command did not finish.

## Sync commit

Last confirmed at `7ae8340b874125565620b80865599c9885003fa6`.

## What this does not cover

Ask work is unleased. The model does not include it.

The pg-boss deferral hop in `armLeaseWatchdogHop` is not a step. A queued item with no live hop is unchecked.

`markLostRunningWorkFailed` and its `NOWAIT` locks are unchecked.

`changeGithubPreflightFailureCount` requires `expires_at > now()`. `reconcileOperationIntent` and `recordPublishStep` use that same predicate. The model follows that fence.

Epochs above 3, a third work item, and a second resource or work type are outside the bound. `Pause` hides deadlock. Liveness of the watchdog is not a property.

The summary double-create depends on both lookups missing `## PR Agent Review`. TLC counts the calls. It does not run GitHub.

When covered code changed and this command was not run, follow `/maintain-formal-verification-skill` at `/home/ubuntu/.cursor/plugins/cache/cursor-public/9717366/d457567332aa6989e753ea289f30ea2bfbc80bc0/skills/maintain-formal-verification-skill/SKILL.md`.
