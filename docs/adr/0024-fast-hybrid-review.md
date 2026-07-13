# ADR 0024 — Fast hybrid Review: shared evidence, four bounded critics, submission-only synthesis

## Status

Accepted. Supersedes ADR 0022 decision §2 (fixed eight-agent fan-out) and ADR 0023 decision §1 (tier-selected roster) and §5 (orchestrator investigates during synthesis). ADRs 0022 and 0023 remain decision history for the unified multi-agent Review run.

## Context

After ADR 0023, the Review pipeline still ran a tier-selected Reviewer roster (up to eight agents), a per-candidate validator fan-out, and an orchestrator that could re-investigate the full diff during synthesis. Observed median latency was six to ten minutes, driven by repeated repository exploration, serial validator sessions, and a heavyweight synthesis tail. Production logs showed 23 Review job attempts with only seven published.

The eight Reviewer agents shared the same tools, report schema, and general evidence contract; their main differentiation was a short role-specific guidance block. Adding roles multiplied broad autonomous investigation more than it created narrowly partitioned work.

## Decision

1. **Shared evidence snapshot.** The Review run builds one immutable, versioned evidence packet covering every changed path, bounded diff context, applicable repository contracts, prior inline feedback, and explicit coverage gaps. Every critic, validator, and synthesis call receives the same snapshot, identified by a deterministic evidence hash. No downstream stage redisCOVERs the changed-file set.

2. **Four domain critics replace the eight-role roster.** Every full Review runs exactly four critics in one parallel wave: Behavioral Correctness and Contracts, Security and Abuse Resistance, Reliability and Concurrency, and Change Safety and Project Standards. Review budget tier continues to steer focus and SLO classification but never selects or omits critics.

3. **Bounded critic exploration.** Each critic receives at most four tool rounds and at most three successful investigation tool calls. The tool surface is restricted to focused workspace reads, literal search, and per-path diff retrieval. The submit capability does not consume the investigation-call budget.

4. **One batched validator.** P0/P1 candidates from all critics are collected into one deterministic batch with stable IDs. At most one validator session runs; it returns `confirmed`, `refuted`, or `unverifiable` per candidate. Only `refuted` candidates are removed; missing, malformed, or unverifiable candidates survive with their validation state. Reviews without P0/P1 candidates skip validation entirely.

5. **Submission-only synthesis.** The synthesis session receives validated critic reports and one structured `submitReview` capability but no investigation tools. It merges, deduplicates, and rejects unsupported claims in one model turn, then publishes. Schema-repair rounds remain available but do not add investigation tools.

6. **Durable checkpoints.** Critic reports and validated synthesis payloads persist to Postgres, keyed by work item, head SHA, evidence hash, critic ID, and prompt-contract version. A pg-boss retry reuses only exact-match artifacts and never reuses state from a stale-head replacement work item.

7. **Rollout modes.** `REVIEW_PIPELINE_MODE` selects `legacy` (eight-role roster, current behavior), `shadow` (legacy publishes plus a sampled non-publishing hybrid comparison), or `hybrid` (four-critic pipeline publishes). Default remains `legacy` until replay, shadow, and publishing canary gates pass.

8. **SLO exemptions.** Large or truncated Reviews may exceed the normal latency target to preserve comprehensive coverage and are recorded as SLO-exempt rather than counted as ordinary latency failures.

## Consequences

- Normal Review fan-out drops from up to eight Reviewer sessions to exactly four critic sessions, plus zero or one validator session and one synthesis session.
- Critics share one evidence hash and never rediscover the changed-file set independently.
- Truncated Reviews derive an authoritative git change set or fail without publishing partial coverage.
- Durable checkpoints enable crash recovery without rerunning completed critics or another synthesis turn.
- Legacy and hybrid modes coexist during rollout; provider pressure reporting distinguishes both plus sampled shadow overhead.
- The eight-role runtime and temporary comparison path are removed after canary gates pass (U7 completion criterion).

## Reversal

Switch `REVIEW_PIPELINE_MODE` back to `legacy`. Critic and payload checkpoint tables remain valid; no schema rollback is required. The legacy eight-role runtime is preserved until final cleanup.
