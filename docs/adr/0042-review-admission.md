# ADR 0042: Trust-gated review admission

## Status

Accepted. Amends approval-mode intake in [ADR 0006](0006-durable-agent-work.md).
Completed-run CI projection remains governed by [ADR 0035](0035-head-ci-state-projection.md).
Operations: [waiting reviews](../agent-work-ops.md#waiting-approval-mode-reviews).

## Context

Approval mode previously waited for an approving PR review from every author.
GitHub prevents authors approving their own PRs, leaving solo maintainers with
only `/review`. Automatic admission needs a durable once-per-PR decision,
independent of whether a work item is still active or retained.

## Decision

- Reuse `SLASH_ALLOWED_ASSOCIATIONS` for trusted non-bot PR authors. Trusted
  authors admit on open. Missing author or association is untrusted. `*` makes
  author admission match auto, including bots. Workflow senders and review
  approvers still fail closed for bots.
- Store `pr_review_admission` keyed by resource, with a pending head and immutable
  admitted reason. Trusted open, workflow approval, approving review, and slash
  review consume the same decision. Pushes only replace in-flight auto reviews.
  Description and verification retain their independent feature modes.
- CI projection continues refreshing facts and independently configured output,
  but skips failing-CI model authoring while the head has any pending admission.
  Once admitted, the next projection can author those facts. Shared-head CI
  authoring waits while any PR on that head remains pending.
- Store workflow `action_required` observations by run ID. Only `event=pull_request`
  and a human sender are eligible. A later `requested`/`in_progress` delivery
  with `queued`/`in_progress` status and no conclusion approves the same
  repository, head, and run. An ordinary rerun without a waiting hold cannot admit.
  Requested waiting payloads record holds too; they must not be mistaken for starts.
- Serialize head discovery before the review intake lock. Reconcile both after
  approving a hold and after recording a pending PR/head. Workflow discovery
  visits resource keys in order; PR discovery only visits its own row.
  Reread admission `FOR UPDATE` and lifecycle after acquiring review exclusion.
  Admission, accepted delivery, acknowledgement, and pg-boss enqueue commit
  together. Queue failure rolls back admission and hold approval.
- Without a row, an approving review retains legacy behavior once and writes an
  admitted row. Workflow approval cannot map a PR without pending admission.
  `/review` consumes an existing pending row; there is no historical backfill.
- Expire holds at 30 days, including eligibility before scheduled retention.
  Purge admission only when both it and a known closed/merged lifecycle marker
  age past work retention. Lock both rows during purge; open admissions survive.
  All admission SQL, including retention, belongs to `reviewAdmission.ts`.

## Payload evidence and limits

Public [Octokit requested payload examples](https://github.com/octokit/webhooks/tree/main/payload-examples/api.github.com/workflow_run)
include `action=requested`, `status=completed`, and `conclusion=action_required`.
That example uses `repository_dispatch`, so it proves the payload shape, not a
fork approval transition. The predicate must also require `event=pull_request`.
[GitHub's fork approval documentation](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/approve-runs-from-forks)
specifies write-access approval and 30-day expiry.

Live capture and live E2E were explicitly omitted for this implementation.
No public same-run waiting-to-started delivery pair was verified. Admission
depends on receiving that evidence; missing or reordered starts fail closed.
Use an approving review or `/review` when the workflow transition is unavailable.

## Consequences and rollout

Default `FEATURE_REVIEW=approval` now spends tokens on trusted PRs at open.
Waiting adds no review output or review model calls. Decision labels and the
two tables provide inspection without parsing PR text.

Migration 035 is additive. Upgrade all web replicas together; mixed old intake
can bypass the once-per-PR decision. Rollback ignores the new tables and restores
old behavior without undoing admitted work. Preserve the tables on rollback.
