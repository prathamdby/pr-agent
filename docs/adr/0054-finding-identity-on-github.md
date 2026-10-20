# ADR 0054: Finding identity on GitHub

## Status

Accepted. Supersedes decision 4 of
[ADR 0024](0024-workspace-primary-grounding-and-evidence.md) (cross-PR finding
history). Amends [ADR 0020](0020-orchestrated-review.md) and
[ADR 0003](0003-structured-review-output.md) (observations carry `relation`;
the `declare_duplicate` tool) and
[ADR 0037](0037-inherit-summary-copy-from-ledger.md) (the findings section and
the check come from the inventory plus the ledger). Amended by
[ADR 0058](0058-judgment-owned-severity.md) for the check threshold and the
upward severity merge. Keeps
[ADR 0029](0029-triage-resolve-completed-threads.md) and
[ADR 0015](0015-verification-silent-resolve.md): triage and verification close fixed
findings; review closes only proven duplicates. Keeps
[ADR 0044](0044-review-validated-artifact-recovery.md): markers are exact
evidence.

## Context

Review identified findings by a content fingerprint stored in Postgres
(`repo_finding_history`, inline batch `fingerprints`). A reworded or moved
observation produced a new fingerprint and a second thread. Review read
identity from the database while triage and verification read GitHub threads,
so the two inventories drifted. The summary and the check covered only the
current run, so an omitted earlier finding stopped failing the check. Losing
the database lost identity.

## Decision

1. **The finding ID is server-minted and lives on GitHub.** Each finding gets
   `f_` plus 26 Crockford base32 characters of randomness, written in a hidden
   `pr-agent:finding` marker on the inline thread root, or a
   `pr-agent:finding-row` marker on a summary-only row. A bot-authored thread
   without a marker gets `l_` plus a hash of its thread node ID. Markers count
   only on bot-authored comments, and finding markers only on thread roots.
2. **GitHub is the authority; Postgres is a retry journal.** Every run builds
   one inventory (`src/review/findingIdentity/findingInventory.ts`) from review
   threads and the summary comment, with a completeness state: `complete`,
   `partial`, `unavailable`, or `permission_denied`. Review, triage, and
   verification consume the same inventory. Resolution receipts
   (`pr-agent:receipt kind=fixed|dismissed|duplicate`) record why a thread
   closed. A human resolve without a receipt counts as dismissed.
3. **Overlap retrieves candidates; the model decides equivalence.** Each
   observation carries a `relation` (`new`, `continues`, `distinct_from`,
   `uncertain`). Retrieval is not only the 10-line window. For each observation,
   candidates are every finding `overlaps()` already returns (same file after
   renames, including a stale or missing line) and the 4 nearest other live
   findings in that file that `overlaps()` did not return. Live means open, or
   accepted earlier in the same run. Rank is the gap between the ranges. A
   stale line stays in the `overlaps()` set and does not consume a nearest
   slot. A `new` observation, or a relation that does not name one of those
   candidates, returns one overlap question instead of a match. A still-unanswered
   finding on the retry lands summary-only. `continues` is accepted only for an
   id in that retrieved set, including when the ranges are more than 10 lines
   apart. A same-file id outside the set, and any cross-file id, is rejected.
   `uncertain` keeps both and links them. An incomplete inventory turns every
   `new` into summary-only. `declare_duplicate` still requires overlapping
   lines. Two files that report one bug stay unlinked unless the model chooses
   `uncertain`. Within one `publish_thread` batch, a finding that repeats a
   higher-priority batch-mate (same placement, or same file, overlapping lines,
   and the same normalized title and detail) is dropped before reconciliation.
4. **The summary and the check cover every open finding.** The lifecycle view
   (`findingLifecycle.ts`) lists this run's findings and carries open threads
   from earlier runs. The check fails while any open finding is at or above
   `REVIEW_CHECK_FAIL_SEVERITY` (default `P2`) and is never `success` while the
   inventory is incomplete and a finding blocks. Reaffirmation stores the
   higher of the held severity and this run's capped severity
   ([ADR 0058](0058-judgment-owned-severity.md)). Summary-only rows are
   carried only until a completed model review does not observe them again.
5. **Review closes only proven duplicates.** The orchestrator proposes a group
   with `declare_duplicate`; same-ID copies need no proposal. The server
   accepts a group only when the inventory is complete and every member is an
   open, fully read thread in the same file on overlapping lines. The thread
   with human replies, else the oldest, stays canonical. Each copy gets one
   receipted `Tracked in <link>` reply and is resolved unless it has human
   replies.
6. **Thread mutations are serialized per PR.** Review duplicate cleanup, triage,
   and verification take the `thread_mutation` session lock
   (`src/db/sessionLock.ts`) and reread the thread before writing a receipt or
   resolving. This is a session lock, not a new lease work type
   ([ADR 0030](0030-pr-actor-lease.md) stays as is).
7. **Cross-PR history is dropped.** `repo_finding_history`, the dismissed
   fingerprint prompt block, fingerprint suppression, and the `findingHistory`
   settings are removed. Migration `041_drop_finding_history.sql` drops the
   table; migration 018 stays because migrations are tracked by filename.

## Consequences

- A database wipe rebuilds the same IDs from GitHub and opens no duplicate
  threads.
- Dismissals no longer carry across pull requests. Durable preferences stay in
  committed `.pr-agent/*.mdc` ([ADR 0017](0017-mdc-repo-policy.md)).
- Recovery journal v2 stores minted IDs and rendered bodies before
  `createReview`; recovery finds published threads by marker. v1 records end as
  `outcome_unknown`.
- Validated review artifacts move to schema version 4. Older artifacts no
  longer bind, so that run recomputes instead of reusing them. Schema version 5
  keeps that rule and stores opened paths so a resumed review does not treat a
  file opened before the crash as unread.
- Workers must upgrade together. Mixed versions disagree on identity.
- Reaffirming a finding posts no reply; it shows only as a summary status.
- A defect split across two files is not retrieved. `uncertain` is the only
  link, and only when the model chooses it. There is no cross-file matcher.

## Alternatives considered

- **Content hash or fingerprint IDs.** Rejected: rewording changes the ID.
- **Automatic match on overlap.** Rejected: two defects on one line are common.
- **Database-primary identity.** Rejected: it drifts from GitHub and dies with
  the database.
- **Rekeying history to IDs.** Rejected: GitHub already holds the within-PR
  outcome, and cross-PR suppression hid real repeats.
- **Editing legacy comments to add markers.** Rejected: node-ID-derived IDs are
  stable without writes.
