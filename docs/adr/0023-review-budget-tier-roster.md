# ADR 0023 — Review budget tier selects Reviewer roster; orchestrator synthesizes only

## Status

Accepted. Partially supersedes ADR 0022 decision §2 (fixed eight-agent fan-out) and the consequence that every full Review run always creates eight reviewer sessions. ADR 0022 remains decision history for the unified multi-agent Review run.

## Context

After ADR 0022, every Review run always launched eight independent Reviewer agents, then a Review orchestrator that reused the exhaustive single-investigator system prompt. Wall-clock latency and provider failures rose: eight discovery sessions plus a ninth rediscovery pass, with optional-angle failures still feeding Degraded review synthesis noise.

A **Review budget tier** already classified pull request size for advisory investigation order. Operators needed that tier to also bound discovery cost while preserving required correctness and security coverage and one public Review payload.

## Decision

1. **Tier-selected Reviewer roster.** Small Review budget tiers still run the full eight Reviewer agents. Medium and large tiers run the core roster only: correctness, security, tests, and reliability (`REVIEW_CORE_REVIEWER_IDS`). Core size matches default `REVIEW_AGENT_CONCURRENCY` so fan-out completes in one concurrency wave.

2. **Omission is policy, not degradation.** Reviewer agents omitted by tier are recorded as `omittedReviewerIds` and reported in trusted synthesis context. They do not count as failures and do not produce a Degraded review. Only selected optional Reviewer agents that fail produce Degraded review. Correctness and security remain required.

3. **Core-roster delegated coverage.** On medium/large tiers, remaining Reviewer prompts absorb high-signal concerns from omitted angles (contract breaks into correctness, hostile inputs into security, races into reliability) without inventing new Reviewer ids.

4. **Small-change volume gate.** A pull request with few files but many line changes is no longer classified small solely by file count. `REVIEW_SIZE_TIER_SMALL_MAX_CHANGES` promotes such changes to medium.

5. **Orchestrator synthesizes only.** The Review orchestrator receives a dedicated synthesis system prompt. It reconciles Reviewer reports, uses tools only for concrete conflicts or unvalidated high-risk claims, does not re-sweep every changed file, and does not originate findings absent from Reviewer reports (except confirming a conflict-implied candidate). Pre-submit nudges no longer demand a full-diff rediscovery pass.

6. **Tighter role tool-round defaults.** Defaults become `MAX_TOOL_ROUNDS`/`MAX_TOOL_ROUNDS_REVIEWER` = 16 and `MAX_TOOL_ROUNDS_VALIDATOR`/`MAX_TOOL_ROUNDS_ORCHESTRATOR` = 8, still overridable by env.

There is no operator toggle to force the full eight-agent roster on large PRs. Reversal requires a new architecture decision.

## Consequences

- Large and medium Review runs use fewer provider sessions and avoid a second concurrency wave under default fan-out concurrency.
- Small Review runs keep full multi-angle coverage where the change set is bounded.
- Metrics and logs expose selected, omitted, completed, and failed Reviewer ids separately.
- Orchestrator latency and rediscovery noise drop; discovery quality depends more on the selected Reviewer agents and their delegated-coverage guidance.
- Provider pressure ceilings still use the full roster length for worst-case capacity planning.

## Reversal

Restore fixed eight-agent fan-out and the exhaustive orchestrator prompt via a new ADR. Historical publish records remain valid; no GitHub or Postgres rewrite is required.
