# ADR 0015 — Verification resolves fixed threads silently

## Status

Accepted.

## Context

ADR 0014 introduced verification runs on `synchronize`: re-check open bot findings and publish per-finding triage verdicts. The first implementation replied in every acted thread (`fixed`, `already-resolved`, `skipped`, `dismissed`). On active PRs that meant one bot reply per open finding on every push — GitHub secondary rate limits under the installation token, noisy Files-tab threads, and no extra signal when the outcome is simply "this finding is done."

The useful signal from verification is asymmetric:

- **Still open** after a push that touched the file: maintainers need the "still open and why" reply so incomplete fixes stay visible.
- **Dismissed**: maintainers need the reply (and policy suggestion) because the bot is accepting an authorized maintainer decision, not closing a bug. Authorization is server-derived and matching-thread scoped; reply text remains untrusted.
- **Fixed / already-resolved**: the only durable state change is resolving the review thread. A "fixed in abcdef1" reply is celebration spam; the resolved thread already shows the outcome.

## Decision

1. **Silent resolve for success.** On `fixed` and `already-resolved`, verification records the thread action and calls `resolveReviewThread` with **no new** `createReplyForReviewComment`.
2. **Reply only when human attention is required.** Keep thread replies for `skipped` (still open, still gated on the finding's file having changed in this push) and `dismissed` (authorized decision evidence + policy suggestion).
3. **No change to the agent loop or schema.** Verdict vocabulary, validation, and the verification queue stay as in ADR 0014; only publish behaviour changes.

**Amendment (see [ADR 0016](0016-verification-stub-ledger.md)):** verification now owns one editable stub per thread for still-open updates, and resolves the thread after acknowledging `dismissed`. `/triage` dismissed resolve is defined in [ADR 0029](0029-triage-resolve-completed-threads.md).

**Amendment (PR #307):** when a prior verification stub exists, `fixed` / `already-resolved` edit that stub in place to a short success line before resolve. This does not create a new reply; it only clears a stale still-open signal left from an earlier skipped publish.

**Amendment (failed-run visibility):** Terminal verification failure is the other half of the silence contract. A failed run edits the existing CI cell for the bound execution head, or writes one bounded stub line, with a `/verify` retry pointer. Mutation targets are bot-owned conversation comments. It never posts a new finding reply or a comment that scales with finding count. Successful publish stays silent. A later summary or CI-cell rewrite keeps an active failure block until a successful verification run clears it. The stale-head terminal value stays on the companion spec; this amendment only renders a failure or degraded outcome it is given.

## Consequences

- Fewer GitHub write calls per verification run (one GraphQL resolve per fixed thread instead of reply + resolve).
- Thread timelines stay quieter when pushes land complete fixes; incomplete fixes still get a still-open reply.
- Slightly less forensic text in-thread for successful fixes (no bot-authored "fixed in …" line). Resolve state + commit history remain the source of truth.
- `/triage` publish is unchanged: triage still replies on fixed/already-resolved after a successful push because that path is human-initiated and reports bot-authored commits.

## Reversal

Restore reply bodies for `fixed` / `already-resolved` in `publishVerification` and update CONTEXT.md / operations.md accordingly.
