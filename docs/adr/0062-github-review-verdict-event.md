# ADR 0062: GitHub review verdict event

## Status

Accepted. Amends [ADR 0020](0020-orchestrated-review.md) for the extra
terminal GitHub review after the summary. Does not reverse
[ADR 0022](0022-remove-merge-verdict.md). Does not reuse
[ADR 0042](0042-review-approval-mode.md). Cadence stays
[ADR 0056](0056-review-cadence.md).

## Context

Incremental thread batches are GitHub `COMMENT` reviews. The close outcome
already decides the check run (`closeOutcomeForCoverage` /
`OwnVerdictOutcome`), but Files changed did not show a matching
`APPROVE` or `REQUEST_CHANGES`. A later `COMMENT` also left this app's
earlier `CHANGES_REQUESTED` or `APPROVE` standing.

GitHub 422s both `APPROVE` and `REQUEST_CHANGES` on a self-authored pull
request. App approvals with Contents: read often do not count as required
reviews. The check run stays the merge gate.

## Decision

1. **Map the close outcome, not `findingCheck`.**
   `githubReviewEventFromCloseOutcome` sits next to `closeOutcomeForCoverage`.
   Published failure is `REQUEST_CHANGES`. Published success is `APPROVE`.
   Published neutral or `kind: "partial"` is `COMMENT`. Cancelled,
   superseded, stale head, crashed, and unpublished submit nothing.
   Partial coverage with a blocker is already published failure.

2. **Keep incremental batches as `COMMENT`.** The terminal review is one extra
   GitHub review after the summary comment has settled, on the reviewed
   `headSha`, with a unique operation-intent marker. It does not count
   against `MAX_THREAD_PUBLISH_CALLS`.

3. **Always show this run.** A terminal `COMMENT` dismisses every this-app
   non-dismissed `CHANGES_REQUESTED` review and every this-app non-dismissed
   `APPROVED` review. A later incomplete run must not leave a prior
   `APPROVE` standing.

4. **Self-review 422 falls back once to `COMMENT`.** Narrow that fallback to
   GitHub's self-review payloads. After the summary has settled, remaining
   createReview or dismiss errors log and do not fail the summary or the
   check.

5. **Verification replaces only a changed standing verdict.** After thread
   actions settle, including the already-resolved shortcut, reload the complete
   finding inventory and use the full review's finding lifecycle threshold.
   Zero blocking findings changes this app's standing `CHANGES_REQUESTED` to
   `APPROVE`; an open blocker changes its standing `APPROVED` to
   `REQUEST_CHANGES`. Human-resolved threads count as resolved. Incomplete
   inventory without a known blocker, a matching verdict, or no standing app
   verdict publishes nothing. A queued or running full review takes precedence.
   Recheck live head, cancellation, and lease ownership before publication.
   Use the verification work item's durable operation marker for retry recovery.
   Errors log without failing verification. This does not refresh the check
   run, commit status, summary, or coverage, and does not open new findings.

## Consequences

- One extra GitHub review (and notification) per published summary.
- Files changed shows this run's event. The check remains the reliable gate.
- Protected-branch dismiss 403 is best-effort.
- Verification adds a GitHub review only when the standing verdict changes.
  App approvals still depend on repository branch rules; verification does not
  make an App approval count as a required human review.

## Reversal

Stop submitting the terminal review. Incremental `COMMENT` batches and the
check run stay.
