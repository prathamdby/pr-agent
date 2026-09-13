# ADR 0022 — Remove merge verdict from the review summary

## Status

Accepted.

## Context

The review summary once included a model-authored **Merge verdict** row (score /5 plus rationale), with consistency clamps when P0/P1 findings were open. Product direction changed: maintainers should assemble merge readiness from the existing gate rows and findings table, without a separate verdict that can still be misquoted as a merge promise.

## Decision

1. **Remove the field.** Drop `mergeVerdict` from `ReviewPayload`, prompt contracts, public-output redaction, and payload validation clamps.
2. **Remove the row.** The summary renderer no longer emits a Merge verdict table row or mechanical fallbacks.
3. **Keep other gates.** The summary comment keeps `size`, findings, tests, security, follow-ups, and CI. The header above the table is a server-built action line (finding count, CI, specialist coverage), not LLM overview prose. Effort is gone. Legacy effort labels are stripped in `src/review/run/reviewLabels.ts`. (Amended when `prCharacter` left `ReviewPayload`; see [ADR 0003](0003-structured-review-output.md).)

## Consequences

- Older model outputs that still emit `mergeVerdict` are stripped by schema parsing and ignored.
- Docs and site mocks that referenced the verdict row are updated in the same change.

## Reversal

Restore the merge-verdict field, clamp, and summary row (or an equivalent design).
