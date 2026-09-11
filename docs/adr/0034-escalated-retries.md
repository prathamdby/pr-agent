# ADR 0034 — Deterministic retry escalation for durable work

## Status

Accepted. Amends [ADR 0023](0023-pi-native-agent-runtime.md) decision 5 (the in-run fallback restart is deleted; the fallback model is reached through retry escalation). Preserves [ADR 0006](0006-durable-agent-work.md) (pg-boss owns retries) and [ADR 0030](0030-pr-actor-lease.md) (every attempt re-acquires the lease with a fresh epoch). Runbook: [docs/agent-work-ops.md](../agent-work-ops.md).

## Context

Retry eligibility used to be one predicate — `classifyFallbackEligibility` — that gated an in-run fallback restart. The orchestrator could retire a failed primary session and start a fresh fallback session from a committed Agent phase checkpoint when availability-class exhaustion was classified. Outside that path, every failed attempt behaved identically, so a run that ended without its terminal submit after its own repair loops replayed the same prompt across the whole pg-boss budget. Provider transport retry also had no operator knob, and a provider-requested `Retry-After` wait was not tied to the run's inactivity cap.

Outcome telemetry was not honest about completion state: `ask failed`, `description failed`, and `verification failed` fired for work items that had completed with a partial publish.

## Decision

1. **Three-valued retry disposition.** `retryDispositionFor` replaces the fallback-eligibility predicate. `transient` (provider timeout, auth, quota, rate limit, unknown, and every other classified failure) keeps the full pg-boss retry budget. `deterministic` (a run that ended without its terminal submit after its own repair loops: `verification.missing_submit`, `triage.missing_submit`, `review.specialist_invalid_report`) gets exactly one escalated retry, then is terminal even when pg-boss budget remains. `terminal` (stale-head replacement exhaustion) never returns to the queue.

2. **Escalation is a pure function of the attempt count.** Attempt 1 is unchanged. Attempt 2 and later get `ESCALATED_TOOL_ROUNDS_MULTIPLIER` (2) × their base structured-loop tool-round budget, capped at `ESCALATED_TOOL_ROUNDS_CAP` (64), and run on the fallback model when `PI_FALLBACK_PROVIDER`/`PI_FALLBACK_MODEL` are configured. An escalated verification attempt narrows its inventory to the `MAX_ESCALATED_VERIFICATION_INVENTORY` (10) oldest open findings and reports `inventory_narrowed`; the remainder waits for a later attempt or run. There is no randomness or jitter in the plan.

3. **Provider transport retry belongs at the shared session factory.** `PI_PROVIDER_RETRY_MAX` (default 2) sets Core `maxRetries` on the loop config and stream options; `PI_PROVIDER_MAX_RETRY_DELAY_MS` (default 60000) bounds a provider-requested retry delay. `loadConfig` throws when the delay cap is not strictly less than `PROVIDER_PROMPT_TIMEOUT_MS`, so provider backoff cannot silently outlast the run's inactivity cap. The wait stays abortable by `/cancel`, lease loss, and worker shutdown. `0` disables transport retries only; Core turn retry after a retryable assistant error stays pinned on (`SESSION_TURN_RETRY_MAX`). Every feature session shares this policy, so it is not a feature-level decision.

4. **In-run fallback recovery is deleted.** `restartWithFallback` and the orchestrator's mid-run fallback restart are gone. A review whose primary model fails retires the session and recovers on the next durable attempt, which re-acquires the PR actor lease with a fresh epoch. Keeping both mechanisms would put model choice in two places — orchestrator control flow and the durable runner — and leave two recovery paths to test.

5. **No escalation switch.** Escalation always follows the attempt count; queue policy (`standard`), retry limits, epoch fencing, and the lease contract are unchanged. pg-boss remains the single retry authority: escalation changes what a retry does, not who schedules it. Escalation never widens privilege — tool access, workspace path policy, repository-policy trust, and the Code Mode capability boundary are identical on every attempt. Ask is deliberately excluded: it is unleased and governed by its own admission quotas ([ADR 0031](0031-ask-admission-quotas.md)).

6. **Outcome events match completion state.** One `"work completed"` event fires per durable work item that a worker completes (`outcome` in `{published, degraded, failed, superseded, lightweight}`). `"work item retried"` fires when a failed attempt returns to the queue and carries `attempt_count`, `next_attempt`, `retry_disposition`, `escalation_kinds`, and classified failure fields without `error_message`. Already-published replay, stale-head replacement, no-open-findings short-circuit, and intake supersede of queued items that never run emit no outcome event.

## Consequences

- A deterministic failure costs at most one extra attempt; the second identical failure is terminal without waiting out the queue budget.
- Escalation rate and degradation reasons are observable from PostHog without reading run transcripts.
- Provider transport retry is operator-tunable and its backoff is bounded by startup validation against `PROVIDER_PROMPT_TIMEOUT_MS`.
- The fallback model is exercised only by escalation, so a fallback misconfiguration surfaces on the second attempt of a retried item.
- A completed work item never emits a failure event; partial publishes are `outcome=degraded` on `"work completed"`.
- Attempts after a retry keep every privilege boundary of attempt 1, so escalation cannot widen repository or tool access.

## Reversal

Restore `fallbackClassification.ts` and the orchestrator restart, drop the disposition and escalation plumbing, and re-emit per-feature failure events. This would reintroduce mid-run model switching and failure events for completed work items, so it is not recommended.
