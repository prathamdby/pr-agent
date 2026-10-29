# ADR 0056: Review cadence

## Status

Accepted. Amends the default cost reasoning in
[ADR 0014](0014-verification-run-work-type.md), the triage-push sentence in
[ADR 0013](0013-triage-autofix-work-type.md), and the admission boundary in
[ADR 0042](0042-review-approval-mode.md).

## Context

`once` reviews an admitted open and replaces an active automatic review when
the head moves. Operators who want a review of each later push had to comment
`/review`. That follow-up is optional, and the default stays `once`.

## Decision

1. **Two cadence values.** `FEATURE_REVIEW_CADENCE` is `once` or `every_push`.
   The default is `once`. `every_push` together with `FEATURE_REVIEW=manual`
   fails startup. Valid pairs are `once` with `manual`, `auto`, or `approval`,
   and `every_push` with `auto` or `approval`.

2. **A push never cancels a slash review.** `every_push` inserts one
   deferred-head automatic review when no slash review is queued or running,
   including a queued stale-head child. A running `/review` is stamped with
   `pushFollowUp` and finishes. The worker then schedules one automatic
   follow-up for the newest head. A second push while that marker is unset
   does not insert another review. A later push leaves a still-queued
   follow-up in place, so claim reads the newest head. A follow-up that has
   left the queue is superseded, and intake inserts one new deferred-head
   review.

3. **Admission is stored evidence.** Under `approval`, an awaiting row skips
   the `every_push` insert, including a maintainer-only hold
   (`workflow_start_admits` false). With no awaiting row, a retained `review`
   work item or `pr_review_approvals.state = 'approved'` admits the push. A
   workflow start is not synchronize admission. `auto` admits every open pull
   request.

4. **Verification still runs on the push.** `FEATURE_VERIFICATION=auto` keeps
   its `synchronize` enqueue. Review and verification both take the thread
   mutation lock and reread the thread before writing. The review loads its
   finding inventory once. A verification resolve during that run can leave
   the new head's check failing on a finding that is already fixed, until the
   next verification or review. That race already exists between `/verify` and
   an active review. `every_push` makes it more common. Verification is not
   sequenced after the review.

## Consequences

- No migration. Upgrade web intake, then workers. An old worker ignores the
  marker. An old web process never stamps it. Rollback is
  `FEATURE_REVIEW_CADENCE=once`. Markers stay inert.
- An audit of this repository's last 60 merged pull requests counted 74
  reviewed heads and 154 distinct CI-run head SHAs, about 2.1 times `once`
  volume. That audit was not remeasured here. Supersede still collapses a
  burst onto one surviving head. `FEATURE_VERIFICATION=off` never
  auto-resolves fixed threads, and a later review can still fail the check
  on findings that are already fixed.
- A `/triage` push is reviewed when cadence is `every_push`. Review,
  verification, and description do not push, and `/triage` does not auto-run.

## Reversal

Set `FEATURE_REVIEW_CADENCE=once`, or remove the setting and the follow-up
marker. `once` intake and verification on `synchronize` stay.
