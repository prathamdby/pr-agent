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
associated as `OWNER`, `MEMBER`, or `COLLABORATOR` start the normal
automatic review immediately. A fork author associated as `CONTRIBUTOR` waits
for a maintainer. A workflow start does not admit that row. Missing association
or a deleted fork is untrusted.
Untrusted PRs insert one `pr_review_approvals` row with `ON CONFLICT DO NOTHING`.
Only a new row queues the awaiting NOTE, with no work item or reaction.
An opened delivery arriving after a retained review work item cannot create
awaiting state, even when that review has finished. The review intake lock orders
this check with slash and automatic admission.

An awaiting row can transition once, under the existing review intake lock:

- `workflow_run` `in_progress` with `event=pull_request` and the awaiting head SHA, when `workflow_start_admits` is true.
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
`manual` is the opt-out. `auto` reviews every open and does not check trust.
Describe and verification triggers do not change.

Rows expire by `updated_at` under the existing 30-day work retention setting.
Expired or already-open PRs can recover through `/review`. The additive migration
and optional acknowledgement fields preserve queued-job compatibility.
Deploy web intake first, then acknowledgement workers, and avoid mixed old/new
intake when relying on one-time approval. Code rollback leaves the table unused.
Requests already in flight cannot be withdrawn. Acknowledgement closes cancelled
review verdicts through `reviewVerdict(...).close`, with the same terminal-only
rule for null or omitted epochs as projector and sweeper repair.

## Reversal

Revert intake and worker code without dropping the table or
`workflow_start_admits`. This restores the old approval behavior, including its
lack of one-time approval after completion. Reverted code trusts a fork
`CONTRIBUTOR` again, and a workflow start can admit maintainer-only rows again.

## Amendment (2026-10-19): contributor forks

GitHub's default Actions policy is "Require approval for first-time contributors".
Under that policy, a user who has had any commit or pull request merged into the
repository does not need a maintainer to approve fork workflows. GitHub documents
this in
[Managing GitHub Actions settings for a repository](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository),
section "Controlling changes from forks to workflows in public repositories".
A fork author associated as `CONTRIBUTOR` can start a pull request workflow alone.
Approval mode used to treat that start as admission.

A fork `CONTRIBUTOR` now waits. The awaiting row stores `workflow_start_admits`
false. A pull request approval or `/review` admits the row. A workflow start does
not. Other untrusted forks keep the column true, so a matching workflow start
still admits them.

Migration `042_pr_review_approvals_workflow_start_admits.sql` adds
`workflow_start_admits boolean NOT NULL DEFAULT true`. Postgres 16 stores that
constant default as metadata. Old inserts that omit the column stay admissible.
There is no backfill. Migrate first, then web intake, then workers. Drain old web
replicas before you rely on the gate. An old web replica still trusts
`CONTRIBUTOR` and ignores the column. Rollback reverts the code and keeps the
column.

These exposures remain:

- After a maintainer admits the pull request, prompt-injection exposure and push-supersede spend match any other approved review.
- An operator who sets `SLASH_ALLOWED_ASSOCIATIONS` to include `CONTRIBUTOR` or `*` lets that author self-admit with `/review`.
- `MEMBER` and `COLLABORATOR` stay trusted.
- `FEATURE_DESCRIBE=auto` still runs on every open, including untrusted forks.
- The "new to GitHub" Actions gap for `NONE`, `FIRST_TIME_CONTRIBUTOR`, and `FIRST_TIMER` remained until the 2026-10-20 amendment.
- Work already in flight is not withdrawn.

Live fork timing on a test GitHub App was not captured for this amendment.

The same admission evidence gates `FEATURE_REVIEW_CADENCE=every_push` pushes ([ADR 0056](0056-review-cadence.md)).

## Amendment (2026-10-20): untrusted fork associations

GitHub's setting "Require approval for first-time contributors who are new to GitHub" does not hold every first-time fork author. A user who has had any commit or pull request merged into any public repository can be `FIRST_TIME_CONTRIBUTOR` or `NONE` on this repository, and that setting still asks a maintainer to approve a `FIRST_TIMER`. This App does not read the repository Actions policy, so approval mode cannot treat a workflow start as maintainer approval for those authors.

A fork author associated as `NONE`, `FIRST_TIME_CONTRIBUTOR`, or `FIRST_TIMER` now waits the same way as a fork `CONTRIBUTOR`. The awaiting row stores `workflow_start_admits` false. A pull request approval or `/review` admits the row. A workflow start does not. `OWNER`, `MEMBER`, and `COLLABORATOR`, and every same-repo open, stay trusted. Describe and verification do not change. Missing association, a deleted fork, and `MANNEQUIN` stay on the workflow-start path.
