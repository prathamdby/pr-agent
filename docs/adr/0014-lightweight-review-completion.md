# ADR 0014 — Lightweight review completion for docs-only auto-reviews

## Status

Accepted.

## Context

Automated pull request reviews run on every `opened`, `synchronize`, and `reopened` event. Documentation-only changes (README updates, `docs/**`, markdown under `.github/*.md`) rarely benefit from a full LLM investigation pass but still consumed worker time and API budget.

Operators may still request a full pass with `/review`.

## Decision

1. **Lightweight review completion.** For automated reviews only, when every changed file matches the strict docs-only allowlist in `src/settings/constants.ts` (via `reviewChangeGate.ts`) and the change set is not truncated, the review worker skips the Review run and edits the existing review progress comment in place.

2. **Ack flow unchanged.** Durable intake still schedules acknowledgement reactions and the in-progress progress stub before the review worker runs.

3. **Slash override.** `/review` and `/review-security` always run a full Review run regardless of file types.

4. **Truncation guard.** A truncated change set never qualifies for lightweight completion.

5. **Public Markdown contract.** Lightweight completion uses `renderLightweightReviewCompletion` in `reviewRender.ts`, preserving sentinel heading, GitHub alert block, and HTML key-value table formatting.

6. **Copy.** Public text: lead note that no deep review run occurred because the change set is documentation-only; table rows for Review, Reason, and Next step (`Use /review for a full review.`).

## Current implementation

- Gate: [`reviewChangeGate.ts`](../../src/review/reviewChangeGate.ts)
- Worker path: [`worker.ts`](../../src/agentWork/worker.ts) `handleReviewJob`
- Render: [`reviewRender.ts`](../../src/review/reviewRender.ts) `renderLightweightReviewCompletion`
- Glossary: [`CONTEXT.md`](../../CONTEXT.md)

## Consequences

- Docs-only PRs get faster feedback without LLM cost.
- Risk: a one-line code change bundled with docs-only files fails the gate (all files must match allowlist).
- Security lens auto-reviews use the same gate; security-heavy docs-only repos still skip unless `/review-security` is invoked.

## Reversal

Remove the gate and always run full Review runs on automated events, or widen the allowlist via constants.
