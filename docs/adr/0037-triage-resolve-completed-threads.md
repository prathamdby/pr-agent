# ADR 0037 — Triage resolves completed threads

## Status

Accepted.

## Context

ADR 0018 treated dismissed as maintainer-owned in two ways: the verdict requires an authorized non-bot maintainer decision matching the finding thread, and the GitHub thread stayed open. ADR 0021/0023 later made dismissed terminal for verification (stub then resolve) but left the triage exception. That left Files-tab threads open after `/triage` had already finished the finding. Policy suggestions already live on the **triage report comment**, so keeping the thread open did not add a unique acknowledgment surface.

## Decision

1. **Resolve when triage is done.** Publish resolves the inline review thread for `fixed` (only after push succeeds), `already-resolved`, and `dismissed`. `skipped` stays open.
2. **Dismissed still needs an authorized maintainer decision.** Validation rejects dismissed without a matching non-bot reply whose server-preserved association is allowed by `MAINTAINER_DECISION_ASSOCIATIONS`; all other replies are untrusted evidence.
3. **No dismissed thread reply.** Triage does not add a Files-tab reply for dismissed; the triage report keeps the policy suggestion. Verification keeps its stub-then-resolve path.
4. **Push-or-nothing for fixes only.** Stale or empty push still skips `fixed` thread actions and still allows `already-resolved` / `dismissed` resolve.

This amends ADR 0018 decision (6) and the “triage never resolves dismissed” clauses in ADR 0021 and ADR 0023.

## Consequences

- `/triage` no longer leaves dismissed findings as unresolved inventory for later verification runs.
- Maintainers still see dismiss rationale and policy suggestions on **`## PR Agent Triage`**.

## Reversal

Restore the publish skip for `dismissed` and the “never auto-resolve dismissed” wording in `CONTEXT.md`, `docs/operations.md` (`/triage` paragraph: reply on `fixed` then resolve; resolve `already-resolved` and `dismissed` without a Files-tab reply, including stale or empty push), and `.pr-agent/triage-safety.mdc` (push-or-nothing before resolving threads).
