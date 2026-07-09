# ADR 0020 — Pushes trigger verification runs, not re-reviews

## Status

Accepted.

## Context

Auto-review is `opened`-only by deliberate decision (`REVIEW_AUTO_ACTIONS`, PR #164): re-reviewing every push is expensive and noisy. But competitor analysis showed the stickiest behavior PR Agent lacks is Greptile's follow-up loop: it re-engages on every push, replies inside each finding's thread with "fixed / still broken and why," and disputes incomplete fixes. That loop, not finding quality, is what closed its findings (3/3 fixed on pr-agent #165).

The concept already existed in the product under another name: a triage run verifies prior findings and emits per-finding verdicts, but it is slash-triggered, writable, and commits fixes.

## Decision

1. **Fifth work type: verification run.** Automatically triggered on `synchronize` when the pull request has open PR Agent findings. Skipped when it has none.

2. **Strictly read-only.** No writable PR checkout, no code edits, no new findings, no full review. It re-checks each open finding against the new head and emits a triage verdict per finding (shared vocabulary with `/triage`: fixed, already-resolved, skipped, dismissed). Publish policy is refined in [ADR 0021](0021-verification-silent-resolve.md): silent resolve for fixed/already-resolved; thread replies only for still-open and dismissed.

3. **Superseded like auto-reviews.** Rapid pushes collapse to the newest head; a stale verification run must not publish.

4. **Distinct name and type.** Not a "re-review" (would inherit review run cost and publish machinery) and not a triage mode (triage is human-initiated and writable). The boundary: review runs find, verification runs verify, triage runs fix.

## Consequences

- Does not reverse PR #164: a verification run never opens new findings, so push-time cost stays bounded by the number of open findings.
- A `/triage` push fires `synchronize`, so triage fixes get independently confirmed by a verification run. Not a loop: verification never pushes.
- Needs its own queue lane and work-item type; finding open/closed state must be readable from stored publish records and thread replies.

## Reversal

Remove the work type, its queue, and the `synchronize` trigger. `/review` and `/triage` are unaffected.
