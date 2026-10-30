# ADR 0060: Tests evidence and unjudged reports

## Status

Accepted. Follows [ADR 0020](0020-orchestrated-review.md),
[ADR 0058](0058-judgment-owned-severity.md), and
[ADR 0059](0059-base-commit-policy-snapshot.md). Private ledgers move
artifacts from schema 7 to 8. `REVIEW_CONTRACT_VERSION` stays `review-3`.

## Context

A tests specialist could publish a missing-test claim without showing the
searches and reads behind it. A judgment turn that failed or never called
`publish_thread` still published that report's findings. The trusted review
context already built for the orchestrator was not on the specialist user
message.

## Decision

1. **A coverage gap names its evidence.** A tests finding sets `testsClaim`
   to `coverage_gap` or `invalidated_test`. A coverage gap includes
   `testEvidence`: one to eight search queries, up to sixteen workspace
   paths, and the gap those reads miss. An empty read list uses one shared
   sentence, `No candidate test was found.` A pure coverage gap, with no
   `criticalPath`, has ceiling P1. P0 requires `criticalPath` and one of
   those two evidence shapes. `invalidated_test` does not take that ceiling.
   The same ceiling applies when a later run reaffirms the finding, using that
   run's `criticalPath`, in place of the tests-lens and test-path P2 caps. A
   held P0 reaffirmed without `criticalPath` ceilings at P1.
2. **The ledger check is a flag.** `REVIEW_TESTS_EVIDENCE` defaults to false.
   When it is true, each coverage-gap read path must have a content read
   recorded by that specialist. `hasOpened` is not enough. A path another
   specialist read does not count. `assertFindingsHaveEvidence` uses that
   same specialist ledger for every specialist. This narrows ADR 0024's
   workspace-read rule to the specialist who cites the lines. The flag
   decides whether a coverage gap requires a content read. It does not
   decide whose read counts. Path traversal and sensitive paths are rejected
   with the flag on or off, including a sensitive path the pull request
   changes.
3. **Specialists receive the existing trusted context.** The string
   `buildTrustedReviewContextForReview` already returns is appended beside
   the specialist brief, outside the brief's untrusted wrap. Policy loading
   is unchanged.
4. **An unfinished judgment publishes nothing from that report.** The report
   is recorded unjudged. Already accepted findings stay. The summary says the
   review was not fully judged. There is no second judge and no deterministic
   finding publication.

## Consequences

Version 7 and older envelopes fail parse and recompute. Do not migrate rows.
A coverage-gap validation failure stays `specialist_invalid_report`. Notes on
judgment dispositions are redacted, capped, and omitted when redaction changes
the string. They are not finding bodies.
