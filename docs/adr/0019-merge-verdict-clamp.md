# ADR 0019 — Merge verdict is model-authored but consistency-clamped

## Status

Superseded by [ADR 0030](0030-remove-merge-verdict.md).

## Context

Competitor analysis (39 merged PRs across three repos, July 2026) showed Greptile's most-valued summary feature is a merge-readiness verdict ("Confidence Score: 4/5 — Safe to merge") with a one-sentence rationale written about its own findings. PR Agent's summary already made one verdict-shaped claim, and it was the one that aged worst: "No security concerns identified" published directly above a P1 symlink traversal that two competitors caught (threadcord #108). A verdict is a quotable promise; a wrong "safe to merge" costs more trust than ten missed findings.

Alternatives considered: a purely derived verdict (computed from finding counts, no model judgment) and no verdict at all. The derived form is safe but loses the rationale prose that makes Greptile's verdict useful; no verdict leaves readers assembling the decision from gate rows.

## Decision

1. **Model-authored verdict.** The review summary comment gains a merge verdict: a score plus a one-sentence rationale the model writes about the run's own findings.

2. **Derived clamp.** Review payload validation rejects inconsistent verdicts: open P1 findings cap the score and forbid safe-to-merge wording. Repair uses the same reject-and-repair loop as other overview gates. The verdict can never contradict the findings table in the same comment.

3. **Pass-scoped wording only.** Verdict and security wording is scoped to the run ("on this pass"), never an absolute safety promise. The existing security row wording is softened accordingly.

4. **Named "merge verdict".** Not "confidence score": per-finding confidence (c2–c4) already exists and the terms must not collide.

## Consequences

- The verdict can only be as wrong as the findings are; it cannot be independently wrong.
- A clamped verdict may trigger one extra validation-repair send.
- Once users rely on the verdict row, changing its semantics is a breaking product change; that is why this is an ADR.

## Reversal

Remove the verdict field from the review payload, the clamp rule from validation, and the row from the summary renderer.
