# ADR 0021 — P3 inline threads for triage autofix

## Status

Accepted.

## Context

P3 findings were summary-only by design ([ADR 0003](0003-structured-review-output.md)): title + deep-link in the review summary, no Files-tab thread. `/triage` inventoriable work is built from unresolved bot **inline** finding threads ([ADR 0013](0013-triage-autofix-work-type.md)), so P3 never entered triage inventory and could not be autofixed. Maintainers still saw P3 in the summary table and wanted the same verify-and-fix loop.

## Decision

1. **P3 is inline-eligible.** `isInlineSeverity` includes P3. When a commentable RIGHT-line anchor resolves, publish posts a normal inline thread (severity label, detail, Prompt to fix). Unanchored P3 stays summary-only like any other severity. Specialist progress ticks count accepted ledger placements (inline plus summary-only); see [ADR 0020](0020-orchestrated-review.md).

2. **`fixPrompt` required for P3.** Same field contract as P0–P2 so the accordion and triage agent have a concrete fix direction.

3. **Check runs stay P0–P2.** Introduce `isCheckFailingSeverity` for review check-run failure. Empty or P3-only payloads still conclude `success`; P3 remains advisory for branch protection.

4. **Triage and verification unchanged in shape.** They continue to discover inventory from eligible inline threads; P3 threads become eligible automatically once posted.

## Consequences

- Files-tab noise can include rare P3 threads; prompts still tell specialists to keep P3 rare.
- Aggregate agent fix prompts render P3 with the same `[P3] @path` + fixPrompt shape as higher severities (plus summary-only tag when unanchored).
- Existing summary-only P3 comments from older reviews remain non-triageable until a new review posts them inline.

## Reversal

Restore `isInlineSeverity` to P0–P2, make `fixPrompt` optional for P3, fold check-run counting back into `isInlineSeverity`, and revert prompt/ADR copy.
