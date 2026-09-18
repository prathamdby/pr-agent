# ADR 0037 — Summary copy is inherited from the ledger

## Status

Accepted.

Amends the summary-table and tool-contract description of
[ADR 0003](0003-structured-review-output.md) (decision 2, row list) and
replaces the `publish_summary` tool description's "Supply display copy"
phrase, which lives in `publishSummaryTool.ts`, not in ADR 0003.

## Context

`publish_summary` required the model to re-emit `title` and `detail` for
every accepted finding, keyed by finding ID (`fixPrompt`, `confidence`, and
`category` were optional). This cost the largest block of synthesis output
tokens, and any missing, unknown, or duplicate ID failed validation into a
repair round (`VALIDATION_REPAIR_ROUNDS`, up to 3 extra sends per run). It
also permitted an inconsistency: the summary table title could differ from
the already-posted inline thread title for the same finding.

The ledger's accepted placements already carry full finding copy, authored by
the judgment phase through `publish_thread`, and the stored batch records
persist that copy through the untouched `reviewFindingSchema`.

## Decision

`publish_summary` takes `size`, `followUps`, `mergeability`, and `blastRadius`.
Finding `title`/`detail`/`fixPrompt` remain ledger-only. Finding copy renders
verbatim from the ledger's accepted placements: the judgment phase's
`publish_thread` text is the display copy, and the summary and inline threads
cannot diverge. `summaryFindingCopySchema`, `validateFindingIds`,
`findingFromCopy`, and `ledgerWithFindingCopy` are deleted.

## Consequences

- The ID-copy validation failure class cannot occur, and the synthesis turn
  emits four gate fields instead of a full finding manifest. The synthesis
  input (the accepted-placements embedding) is unchanged.
- The model has no last-pass authority over PR-facing finding prose after
  judgment. Revisions to wording happen during judgment, via `publish_thread`.
- Same-PR amendment: ADR 0003's decision 2 summary-table row list and the
  tool description are updated to match.

## Reversal

Restore `summaryFindingCopySchema` and the ID-keyed copy fields to
`publish_summary`, and the copy-writing helpers to the summary tool. The
ledger keeps carrying full copy either way, so the seam is shallow.
