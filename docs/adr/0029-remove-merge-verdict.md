# ADR 0029 — Remove merge verdict from the review summary

## Status

Accepted. Supersedes [ADR 0019](0019-merge-verdict-clamp.md).

## Context

ADR 0019 added a model-authored **Merge verdict** row (score /5 plus rationale) to the review summary comment, with consistency clamps when P0/P1 findings were open. Product direction changed: maintainers should assemble merge readiness from the existing gate rows and findings table, without a separate verdict that can still be misquoted as a merge promise.

## Decision

1. **Remove the field.** Drop `mergeVerdict` from `ReviewPayload`, prompt contracts, public-output redaction, and payload validation clamps.
2. **Remove the row.** The summary renderer no longer emits a Merge verdict table row or mechanical fallbacks.
3. **Keep other gates.** Effort, findings, relevant tests, security, CI, and follow-ups remain the overview surface.

## Consequences

- Older model outputs that still emit `mergeVerdict` are stripped by schema parsing and ignored.
- Docs and site mocks that referenced the verdict row are updated in the same change.

## Reversal

Restore ADR 0019’s field, clamp, and summary row (or an equivalent design).
