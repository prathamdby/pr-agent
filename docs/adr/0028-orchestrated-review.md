# ADR 0028. Orchestrated review runs

## Status

Accepted.

This ADR supersedes [ADR 0006](0006-security-review-summary-sentinel.md) and
[ADR 0016](0016-review-quality-lens.md). It amends [ADR 0005](0005-structured-review-output.md),
[ADR 0009](0009-durable-agent-work.md), and [ADR 0011](0011-review-pointer-link.md).

## Context

The previous product ran separate security, quality, tests, and general review
lenses. Each lens re-explored the pull request, kept its own progress comment,
and produced a separate summary. That made first feedback slow and left slash
reviewers with shallow context about the other investigations.

The redesign keeps one durable work item and gives one long-lived review
orchestrator enough context to coordinate four independent investigations.

## Decision

### One run and a fixed roster

Each automated or `/review` request creates a single orchestrated review run.
The review orchestrator performs reconnaissance, writes a specialist brief,
and starts four specialists in parallel. The fixed roster covers correctness, security, quality, and tests:

1. correctness
2. security
3. quality
4. tests

The specialist brief carries pull request intent, architecture notes, risk
areas, the file map, and focus for each specialist. A specialist returns one
specialist report. `no_findings` is a successful empty report, not a failure.

### Normal-review latency amendment

Normal orchestrated reviews use deterministic bookends. The server builds the
specialist brief from PR intent, changed paths, risk-path flags, and loaded
repository context. Evidence-valid specialist reports publish without one
serial judgment model turn per report. The server renders the final summary
from the accepted finding ledger and run state.

The active-compute budget is 900000 ms from orchestrator entry through terminal
publication. Each of the four specialists has a 480000 ms cap. A budget hit
names the budget key, limit, used time, and partial inspected scope. It can
never become clean `no_findings`. `no_findings` means no qualifying finding
within inspected coverage.

Exhaustive review is outside the normal contract. A future deep mode must be
labeled separately and must not promise the 15-minute SLA.

### Incremental publishing

The server validates reports as they resolve and may publish a thread batch
through one GitHub `COMMENT` review. A run can publish multiple
GitHub reviews, one per accepted batch, up to `MAX_THREAD_PUBLISH_CALLS`.
The final summary is published only after all specialists resolve or the run
enters budget-driven deterministic finalization.

The single review progress comment is edited with a specialist tick after each
specialist resolves. After deterministic publication, the specialist row count
is the number of **accepted placements** in the
finding ledger for that specialist (posted or resumed **inline review threads**
plus **summary-only findings**). "No findings" means zero acceptances or an
explicit empty / `no_findings` report — never "zero inline threads" alone when
summary-only acceptances exist. The final summary replaces the last tick in
place and must not contradict that ledger truth.

### Retry and degradation

Provider errors, rate limits, and timeouts retry according to the bounded
specialist and orchestrator retry contracts. A specialist that fails twice is
recorded as failed while the other reports continue. Partial coverage produces
a neutral Checks conclusion, an error commit status when enabled, and an
explicit partial-coverage note.

If all four specialists fail for non-budget reasons, the worker publishes a
failure notice and no summary table. Budget failures publish an explicit
partial-coverage summary, even when all four specialists hit a limit. A
thread-publish budget exhaustion downgrades later findings to summary-only rows;
they are never silently dropped.

### Durability and deadlines

The existing `publish_records` table needs no migration. All incremental
`inline_review` batches for a pull request and review run stay in one row. The
`detail` JSONB stores an atomically appended `batches` array. Each entry records
the GitHub review id, fingerprints, event, URL, and counts. Resume logic reads
that array to recover all review ids and suppression fingerprints.

The executor computes the hard return deadline at
`startedOn + expireInSeconds * 0.8`. Model work stops before that deadline by
`REVIEW_FINALIZATION_WINDOW_MS`, leaving time to abort and join provider
sessions, persist batches, publish the summary, update Checks, write the commit
status, and sync labels. A handler must return before pg-boss can expire and
redeliver it.

### Compatibility

New intake, prompts, publish records, fingerprints, comments, and check runs
write only the `review` mode. Historical `review-security`, `review-quality`,
and `review-tests` values remain readable from old work items, comments,
publish records, triage inventory, and fingerprints. The fingerprint mode
changes for new runs, so legacy fingerprint candidates are checked during
suppression. Old summary comments continue to receive CI refreshes when their
metadata is valid. No old inline finding is reposted solely because the new
run uses the general mode.

### Consequences

- There is a single active review slot per pull request. Duplicate `/review` commands
  acknowledge the caller without enqueueing another run.
- A run can create multiple GitHub reviews because each thread batch is an
  independent `COMMENT` event. This increases notification volume to roughly
  five author notifications in the common four-specialist case. The product
  accepts that cost for incremental feedback.
- The Checks name is `PR Agent Review`. Branch protection rules must remove the
  three old per-lens check names.
- `ReviewPayload` and its validation survive as the deterministic summary
  publisher input contract, while the orchestrator owns specialist coordination
  and incremental batch state.

## Impact on earlier ADRs

- [ADR 0005](0005-structured-review-output.md) still defines the validated
  payload schema used by the summary publisher. Its old single-submit wording
  does not describe orchestration.
- [ADR 0011](0011-review-pointer-link.md) now applies to the single general
  review summary per pull request, not independent lenses.
- [ADR 0006](0006-security-review-summary-sentinel.md) and [ADR 0016](0016-review-quality-lens.md)
  remain as superseded historical records. Their sentinels and commands are
  recognized only for compatibility.

## Reversal

Reintroduce separate work items, prompts, sentinels, check names, and singleton
keys for each lens, then remove the orchestrator roster and batch ledger. This
would restore the slower first feedback and duplicate investigation that this
decision addresses.
