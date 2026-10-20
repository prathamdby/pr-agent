# ADR 0058: Judgment-owned severity

## Status

Accepted. Amends decision 3 of [ADR 0021](0021-p3-inline-triage.md) and
decision 4 of [ADR 0054](0054-finding-identity-on-github.md). Follows
[ADR 0044](0044-review-validated-artifact-recovery.md) for the schema bump.
[ADR 0025](0025-prompt-assembly.md) stays intact: the rubric is one shared
block rendered by import, not four copies.

## Context

Specialists graded their own severity, and the review check failed on every
open P0, P1, and P2. A test gap and a missing file read could publish as P0.
Judgment copied title and detail as written and did not re-grade. Operators
could not move the failing line without a code change.

## Decision

1. **Judgment assigns the published severity.** Specialists report
   `suggestedSeverity`. `publish_thread` requires `severity` and a trimmed,
   non-blank `severityRationale` of at most
   `REVIEW_FINDING_SEVERITY_RATIONALE_MAX_CHARS`. The report field is not on
   the publish schema. One `severityRubric` in `src/prompts/shared/behavior.ts`
   feeds the prompts and the schema descriptions. P0 is a demonstrated,
   reachable, consequential failure read this session. P2 is the ceiling for
   test-gap findings. An inflated P0 or P1 costs the same trust as a missed
   defect.
2. **The server caps classes of P0 that cannot exist.**
   `cappedFindingSeverity` writes the cap onto the finding that reconcile and
   publish share. A tests-lens finding caps at P2. An anchor whose path matches
   `REVIEW_RISK_PATH_PATTERNS.test` caps at P2. An unjudged publish caps at P1.
   The strictest cap wins. There is no docs cap. A skipped judgment copies the
   suggestion onto `severity`, omits the rationale, and then hits the same cap.
3. **Reaffirmation keeps the higher severity, then the cap.** When the
   inventory holds the finding, the stored severity is `higherSeverity` of the
   held value and this run's observation, passed through
   `cappedFindingSeverity` again. The tests-lens, test-path, and unjudged
   ceilings apply to that merge, using the observation path and the held
   path. The finding view applies the same cap after it merges a reaffirmed
   row, including a duplicate-copy severity. The thread root is not edited.
   An unobserved carried finding keeps its inventory severity. An unobserved
   `unknown` stays unblocking. A reaffirmation that observes it may merge
   upward to the judged severity, still inside the cap.
4. **`REVIEW_CHECK_FAIL_SEVERITY` is the failing line.** Allowed values are
   `P0`, `P1`, `P2`, and `P3`. The default is `P2`, which keeps today's gate.
   A known severity fails when its rank is less than or equal to the threshold
   rank. `P3` fails only when the threshold is `P3`. An empty string is
   `config.invalid_enum`. There is no `off` value. Partial specialist coverage
   stays check `neutral`. An incomplete inventory fails only when something
   blocks. Repair reads the stored verdict, including `ownCheckFailSeverity`,
   and does not recompute from the live threshold.
5. **Artifacts move to schema 6 and contract `review-2`.** A version miss
   recomputes. Receipts stay authoritative. The threshold is part of
   `cfg.review`, so a change misses the in-flight artifact cache.
   [ADR 0059](0059-base-commit-policy-snapshot.md) later moves the contract to
   `review-3` for policy provenance. Schema 6 stays.

## Consequences

- The default install still fails P0, P1, and P2. Setting the threshold to
  `P1` lets a P2-only head succeed.
- Decision events count `severityRaised` and `severityLowered` after the cap,
  matched to one report row. A split row counts as neither. The later upward
  merge is not movement.
- Rationale is redacted with the finding text and is not rendered or sent as a
  product-event property.
- Upgrade review-bearing workers together. Old workers treat schema 6 as a
  cache miss. Rollback is a code revert. The old binary ignores the new env
  var, and an already selected check is not rewritten.

## Reversal

Return `severity` to the specialist report, delete the cap and the threshold,
and restore the hardcoded P0–P2 check. Schema 6 artifacts then miss and
recompute.
