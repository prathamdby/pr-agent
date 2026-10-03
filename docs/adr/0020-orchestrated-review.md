# ADR 0020. Orchestrated review runs

## Status

Accepted.

This ADR replaces separate security, quality, and tests lens work items and
sentinels. It amends [ADR 0003](0003-structured-review-output.md),
[ADR 0006](0006-durable-agent-work.md), and [ADR 0008](0008-review-pointer-link.md).

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

### Incremental publishing

The orchestrator judges reports as they resolve. A judgment turn independently
re-applies the causal-publication contract: one atomic problem with a concrete
trigger, PR-introduced or PR-exposed wrong behaviour or a precise unprotected
regression, an observable consequence, ledger-authorized reviewed-head
evidence, and a bounded fix direction. A compound candidate is split into
atomic findings; each qualifier is published and the bundle is not. Specialist
reports remain evidence, never authority. A judgment turn may publish a
thread batch through one GitHub `COMMENT` review. A run can publish multiple
GitHub reviews, one per accepted batch, up to `MAX_THREAD_PUBLISH_CALLS`. The
final summary is published only after all specialists resolve or the run
enters its deterministic degradation path.

The single review progress comment is edited with a specialist tick after each
specialist resolves. After publish (model judgment or deterministic degrade),
the specialist row count is the number of **accepted placements** in the
finding ledger for that specialist (posted or resumed **inline review threads**
plus **summary-only findings**). "No findings" means zero acceptances or an
explicit empty / `no_findings` report — never "zero inline threads" alone when
summary-only acceptances exist. The final summary replaces the last tick in
place and must not contradict that ledger truth.

Revisioned progress and summary upserts hold the existing resource/lens advisory
lock from the fresh comment read through preparation, GitHub upsert, and result
record. A later contender observes the preceding write before deciding; an older
tick from the same run cannot restore stale progress or replace its final summary.
The pre-write claim remains autocommitted, with no transaction across HTTP.
Contenders release clients before bounded retries, and per-pool admission leaves
at least half the connections for nested mutation checks and unrelated database
work. The active holder retains its client while GitHub settles. Acquisition
failures prove nonacceptance to operation intents; delegated and post-write
failures keep existing recovery rules.
CI projection and direct comment edits do not share this lock.

Intake or stale-head reschedule can transfer progress ownership while the
earlier run still holds its actor lease. Foreign-owner ticks above revision
zero warn and skip at preflight. An owner-gated progress write that affects
zero rows rechecks the lease, then logs and raises an ownership conflict
when that lease still holds or the writer is unleased. The owner predicate
and lease fencing remain unchanged. A conflict after a GitHub edit does not
authorize replaying that mutation or overwriting the replacement's metadata.

### Retry and degradation

Provider errors, rate limits, and timeouts retry according to the bounded
specialist and orchestrator retry contracts. A specialist that fails twice is
recorded as failed while the other reports continue. Partial coverage produces
a neutral Checks conclusion, an error commit status when enabled, and an
explicit partial-coverage note.

If all four specialists fail, the worker publishes a failure notice and no
summary table. If the orchestrator judgment session fails twice, accepted
reports flow through deterministic finding publication and the summary is
rendered from the server-owned run state with a judgment-degraded note. A
judgment turn that returns without calling `publish_thread` for a non-empty
report (tool budget, output limit, or prose only) takes the same degradation
path, and its decision event records `degradedReason: "judgment_unpublished"`
with the turn end. A thread-publish budget exhaustion downgrades later findings to summary-only rows;
they are never silently dropped.

Every non-idempotent GitHub publish is guarded by a durable operation intent.
The intent is marked as mutating before the provider call and stores the
result before it is reconciled. If a provider call can have been accepted but
its response is missing, recovery first checks the authoritative
`publish_records` row and then reconciles only an exact work-item-scoped
operation marker or provider id. Completed recovery without a usable result
records terminal local resolution while retaining `outcome_unknown`: the worker
does not blindly repeat the mutation or consume the remaining retry budget.
Failed or incomplete evidence reads remain transient. Already-published summaries stay
authoritative; an unpublished run uses its existing terminal failure notice.
Automatic retry of the mutation is limited to errors that prove
the provider rejected the mutation before acceptance; otherwise the run uses
the bounded deterministic degradation path (including the ask fallback only
after the inline mutation is proven absent).

### Durability and deadlines

Review-specific validated artifact recovery is defined by
[ADR 0044](0044-review-validated-artifact-recovery.md). Default-off recovery can
retain redacted briefs/reports, an ordered prepared/settled publication journal,
and summary inputs. It does not restore a transcript or replace operation
receipts. Reused reports require fresh governed evidence reads; judgment starts
a fresh session with normal trusted context and untrusted saved output.
Resumed workspace/read/model work still charges admitted `beginAttempt`.
This addition does not change the deadlines below.

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
- `ReviewPayload` and its validation survive as the summary tool contract,
  while the orchestrator owns specialist coordination and incremental batch
  state.

## Impact on earlier ADRs

- [ADR 0003](0003-structured-review-output.md) still defines the validated
  payload schema used by the summary publisher. Its old single-submit wording
  does not describe orchestration.
- [ADR 0008](0008-review-pointer-link.md) now applies to the single general
  review summary per pull request, not independent lenses.
- Historical `review-security`, `review-quality`, and `review-tests` sentinels
  and commands remain readable for compatibility only.

## Reversal

Reintroduce separate work items, prompts, sentinels, check names, and singleton
keys for each lens, then remove the orchestrator roster and batch ledger. This
would restore the slower first feedback and duplicate investigation that this
decision addresses.
