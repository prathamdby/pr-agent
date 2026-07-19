# ADR 0021 — Verification resolves fixed threads silently

## Status

Accepted.

## Context

ADR 0020 introduced verification runs on `synchronize`: re-check open bot findings and publish per-finding triage verdicts. The first implementation replied in every acted thread (`fixed`, `already-resolved`, `skipped`, `dismissed`). On active PRs that meant one bot reply per open finding on every push — GitHub secondary rate limits under the installation token, noisy Files-tab threads, and no extra signal when the outcome is simply "this finding is done."

The useful signal from verification is asymmetric:

- **Still open** after a push that touched the file: maintainers need the "still open and why" reply so incomplete fixes stay visible.
- **Dismissed**: maintainers need the reply (and policy suggestion) because the bot is accepting human intent, not closing a bug.
- **Fixed / already-resolved**: the only durable state change is resolving the review thread. A "fixed in abcdef1" reply is celebration spam; the resolved thread already shows the outcome.

## Decision

1. **Silent resolve for success.** On `fixed` and `already-resolved`, verification records the thread action and calls `resolveReviewThread` with **no** `createReplyForReviewComment`.
2. **Reply only when human attention is required.** Keep thread replies for `skipped` (still open, still gated on the finding's file having changed in this push) and `dismissed` (evidence + policy suggestion).
3. **No change to the agent loop or schema.** Verdict vocabulary, validation, and the verification queue stay as in ADR 0020; only publish behaviour changes.

**Amendment (see [ADR 0023](0023-verification-stub-ledger.md)):** verification now owns one editable stub per thread for still-open updates, and resolves the thread after acknowledging `dismissed`. The original “never auto-resolve dismissed” rule remains true for `/triage` only.

## Consequences

- Fewer GitHub write calls per verification run (one GraphQL resolve per fixed thread instead of reply + resolve).
- Thread timelines stay quieter when pushes land complete fixes; incomplete fixes still get a still-open reply.
- Slightly less forensic text in-thread for successful fixes (no bot-authored "fixed in …" line). Resolve state + commit history remain the source of truth.
- `/triage` publish is unchanged: triage still replies on fixed/already-resolved after a successful push because that path is human-initiated and reports bot-authored commits.

## Reversal

Restore reply bodies for `fixed` / `already-resolved` in `publishVerification` and update CONTEXT.md / operations.md accordingly.
