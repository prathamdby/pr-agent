# ADR 0042 — Review approval mode

## Status

Accepted. Feature contract: [features.md](../features.md). Recovery and rollout:
[review approvals](../agent-work-ops.md#review-approvals).

## Context

Approval mode previously held every PR until an approving PR review. Authors
cannot approve their own PRs, and workflow approval was not recognized. Checking
only active review work also allowed a later approval to start a second review
after the first finished.

## Decision

Decide trust once, on `pull_request` `opened`. Same-repo heads and authors
associated as `OWNER`, `MEMBER`, `COLLABORATOR`, or `CONTRIBUTOR` start the normal
automatic review immediately. Missing association or a deleted fork is untrusted.
Untrusted PRs insert one `pr_review_approvals` row with `ON CONFLICT DO NOTHING`.
Only a new row queues the awaiting NOTE, with no work item or reaction.

An awaiting row can transition once, under the existing review intake lock:

- `workflow_run` `in_progress` with `event=pull_request` and the awaiting head SHA.
- A submitted approving PR review from a non-bot in `SLASH_ALLOWED_ASSOCIATIONS`.
- An admitted `/review`, including `/review force`.

Workflow starts resolve empty fork PR arrays through the awaiting-head index.
Multiple PR targets acquire locks in sorted resource-key order. The head
predicate is rechecked in the approval update after locking; a push first
invalidates a run for the old head. Approval, work creation, and queue jobs
commit with the accepted event in one transaction. Approval signals without
an awaiting row do nothing, including after a completed review. Automated
approval reviews keep the existing `auto` source and deferred-head binding.

Synchronize moves awaiting heads without starting work, and still supersedes
active automated reviews. Close/merge withdraws awaiting state and queues the
existing cancellation notice. Waiting and closed notices reread state and
progress ownership under the progress-publication lock. The closed notice uses
revision 1 so it replaces the waiting revision 0. No backfill or reopen-created
awaiting records are provided; use `/review`.

## Signal evidence

[GitHub's fork approval documentation](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/approve-runs-from-forks)
states that runs may need approval from a maintainer with write access and that
approval expires after 30 days, marking the run failed. A failed `completed`
delivery must therefore never authorize a review. Completed workflow deliveries
retain the existing CI refresh path, independent of review mode.

The repository install instructions already subscribe to `workflow_run` and
require Actions: read. GitHub community discussion #25220 reports empty
`pull_requests` arrays for fork workflow runs.

Live before/after capture on the planned fork at `98c2921` was not run. The user
explicitly authorized proceeding without it. The expected lack of `in_progress`
before approval, its emission after approval, and exact head SHA/PR-array shape
remain unverified against the test App. The planned non-own GitHub Actions
`check_run` `created` fallback was not selected because the assumption was not
disproved. Parser and database checks prove our filters, not GitHub's delivery
timing. Do not represent a workflow start as independently verified evidence
that a human clicked approval under every Actions policy.

## Consequences

Approval remains the default, so trusted opens now spend review tokens.
`manual` is the opt-out. Trust is independent of Actions policy: a `CONTRIBUTOR`
fork author is reviewed even if all external workflows require approval.
Describe and verification triggers do not change.

Rows expire by `updated_at` under the existing 30-day work retention setting.
Expired or already-open PRs can recover through `/review`. The additive migration
and optional acknowledgement fields preserve queued-job compatibility.
Deploy web intake first, then acknowledgement workers, and avoid mixed old/new
intake when relying on one-time approval. Code rollback leaves the table unused.
Requests already in flight cannot be withdrawn.

## Reversal

Revert intake and worker code without dropping the table. This restores the old
approval behavior, including its lack of one-time approval after completion.
