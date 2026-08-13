# ADR 0038 — Derived merge-loop briefing, not a merge verdict

## Status

Accepted. Complements [ADR 0030](0030-remove-merge-verdict.md). Does not restore a merge verdict.

## Context

Review, verification, and triage already exist as separate work types. Maintainers still reconstruct merge-loop state from the summary, open threads, and CI. Augment's PR-to-merge loop (risk, deep review, pair-review judgment, repair, evidence, human ownership) maps onto those pieces, but a model-authored "safe to merge" score was removed in ADR 0030 because it is a quotable promise.

## Decision

1. **Deep vs pair, same run.** Specialists remain Deep Reviewers: objective defects only. Synthesis may emit `judgmentCalls` (at most three) for product or architecture decisions that still need a human. Those are not findings and not follow-ups.
2. **Derived Next row.** The review summary gains a **Next** row computed from this run's findings and CI. Copy never says approve, ready to merge, or safe to merge. A human still decides merge.
3. **`/loop` is evidence, not a model.** The command is ack-only and spends no tokens. The acknowledgement worker reads the current head, the review progress/summary comment, open bot threads, and a lightweight CI snapshot, then replies under `## PR Agent Loop`. It does not merge, approve, or change findings.
4. **No new `FEATURE_*`.** `/loop` is always available, like `/help` and `/cancel`.

## Consequences

- The summary and `/loop` make the mechanical next action visible without reversing ADR 0030.
- Older `publish_summary` payloads that omit `judgmentCalls` parse as an empty list.

## Reversal

Drop `judgmentCalls`, the Next row, `/loop`, and this ADR's glossary terms.
