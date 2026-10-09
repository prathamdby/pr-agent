# ADR 0034 — Deterministic retry escalation for durable work

## Status

Accepted. Amends [ADR 0023](0023-pi-native-agent-runtime.md) decision 5 (the in-run fallback restart is deleted; the fallback model is reached through retry escalation). Preserves [ADR 0006](0006-durable-agent-work.md) (pg-boss owns retries) and [ADR 0030](0030-pr-actor-lease.md) (every leased attempt re-acquires the lease with a fresh epoch). Terminal reviews use one `reviewVerdict(...).close` writer; the diagnostics sweeper retains its lost-running predicate and crashed-verdict repair. Amended: `agent_work_items.attempt_count` advances only at fresh work admission. Lifecycle claims, watchdog hops and recovery-only completion are budget-neutral; substantive running resumes still spend another attempt. Runbook: [docs/agent-work-ops.md](../agent-work-ops.md).

## Context

Retry eligibility used to be one predicate — `classifyFallbackEligibility` — that gated an in-run fallback restart. The orchestrator could retire a failed primary session and start a fresh fallback session from a committed Agent phase checkpoint when availability-class exhaustion was classified. Outside that path, every failed attempt behaved identically, so a run that ended without its terminal submit after its own repair loops replayed the same prompt across the whole pg-boss budget. Provider transport retry also had no operator knob, and a provider-requested `Retry-After` wait was not tied to the run's inactivity cap.

Outcome telemetry was not honest about completion state: `ask failed`, `description failed`, and `verification failed` fired for work items that had completed with a partial publish.

## Decision

1. **Three-valued retry disposition.** `retryDispositionFor` replaces the fallback-eligibility predicate. `transient` (provider timeout, auth, quota, rate limit, unknown, and every other classified failure) keeps retrying while budget remains. `deterministic` (`verification.missing_submit`, `triage.missing_submit`, `review.specialist_invalid_report`) retains the existing one escalated replay after attempt 1, when budget permits; a second failure is terminal. `terminal` (stale-head replacement exhaustion, cancellation, and `agent_work.attempts_exhausted`) never returns to the queue. The durable work budget remains `QUEUE_RETRY_LIMIT + 1`, independent of pg-boss `retryCount` restarting on hop jobs. Lifecycle claim does not increment it. A separate short transaction locks the exact lease, then the running uncancelled item in a later statement, checks the stored limit and increments once for fresh feature work. Fresh admission at the cap selects the existing failed mark, failure hook, reaction and verdict closure. Recovery-only branches remain reachable at the cap.

   Work admission commits before workspace preparation, agent computation or
   triage bulk patch replay. It is the linearization point, not evidence of a
   provider call. An interrupted committed admission still counts, even if the
   process stops before that call. Rollback does not charge. Ambiguous commit
   acknowledgment never permits a refund or blind in-dispatch retry; a later
   delivery rereads the durable count. A rolled-back `40P01` start retries once.
   The runner memoizes the in-flight admission promise per dispatch and updates
   its read-only claim/escalation views only after acknowledged admission.
   Actual fresh work resumed from `running` charges again. Before admission,
   transient auth/head/storage/recovery failures keep the existing pg-boss
   infrastructure limit and original cause, not work exhaustion.

   Completed mutation recovery without a usable result is also `terminal`:
   only `operation_intent.mutation_outcome_unknown` qualified by
   `context.unknownResolution === "terminal"` selects that disposition.
   Persisted unknown intents retain their remote uncertainty and cache the
   terminal decision in JSONB detail. Recovery-read/ledger failures, truncated
   check listings, and
   unqualified legacy unknown errors remain transient. A fenced-out terminal
   write reasserts cancellation/ownership; a null write with valid ownership is
   a transient persistence failure. No success sentinel or retryable `failed`
   intent is fabricated. The existing terminal hook and own-verdict writer run
   once; terminal queue replay cannot claim or burn another attempt.

2. **Escalation is a pure function of the attempt count.** Attempt 1 is unchanged. Attempt 2 and later get `ESCALATED_TOOL_ROUNDS_MULTIPLIER` (2) × their base structured-loop tool-round budget, capped at `ESCALATED_TOOL_ROUNDS_CAP` (4000), and run on the fallback model when `PI_FALLBACK_PROVIDER`/`PI_FALLBACK_MODEL` are configured. An escalated verification attempt narrows its inventory to the `MAX_ESCALATED_VERIFICATION_INVENTORY` (10) oldest open findings and reports `inventory_narrowed`; the remainder waits for a later attempt or run. There is no randomness or jitter in the plan.

3. **Provider transport retry belongs at the shared session factory.** `PI_PROVIDER_RETRY_MAX` (default 2) sets Core `maxRetries` on the loop config and stream options; `PI_PROVIDER_MAX_RETRY_DELAY_MS` (default 60000) bounds a provider-requested retry delay. `loadConfig` throws when the delay cap is not strictly less than `PROVIDER_PROMPT_TIMEOUT_MS`, so provider backoff cannot silently outlast the run's inactivity cap. The wait stays abortable by `/cancel`, lease loss, and worker shutdown. `0` disables transport retries only; Core turn retry after a retryable assistant error stays pinned on (`SESSION_TURN_RETRY_MAX`). Every feature session shares this policy, so it is not a feature-level decision.

4. **In-run fallback recovery is deleted.** `restartWithFallback` and the orchestrator's mid-run fallback restart are gone. A review whose primary model fails retires the session and recovers on the next durable attempt, which re-acquires the PR actor lease with a fresh epoch. Keeping both mechanisms would put model choice in two places — orchestrator control flow and the durable runner — and leave two recovery paths to test.

5. **No escalation switch.** Escalation always follows the attempt count; queue policy (`standard`), retry limits, epoch fencing, and the lease contract are unchanged. pg-boss remains the single retry scheduler: escalation changes what a retry does, not who schedules it, and the durable attempt count is the single retry budget. Escalation never widens privilege — tool access, workspace path policy, repository-policy trust, and the Code Mode capability boundary are identical on every attempt. Ask is deliberately excluded: it is unleased and governed by its own admission quotas ([ADR 0031](0031-ask-admission-quotas.md)).

6. **Outcome events match completion state.** One `"work completed"` event fires per durable work item that a worker completes (`outcome` in `{published, degraded, failed, superseded, lightweight}`). `"work item retried"` fires only when an acknowledged admitted work attempt returns to the queue, with unchanged `attempt_count`, `next_attempt`, `retry_disposition`, `escalation_kinds` and classified failure fields including sanitized `error_message`. Pre-admission infrastructure retries remain log-only in `agent_work_retrying`, with phase, acknowledgment and stored count. Profile flush reads the latest claim. GitHub-domain failures retain known `http_status` and `request_path`. `cause_chain` stays log-only. Already-published replay, stale-head replacement, no-open-findings short-circuit, and intake supersede of queued items that never run emit no outcome event.

7. **Terminal review GitHub outcomes share one writer.** `reviewVerdict(...).close` is the only path that finishes `PR Agent Review` and optional `pr-agent/review`. Live executions fence on the lease epoch. Unleased callers pass `leaseEpoch: null` and write only after `agent_work_items.status` is terminal. The CI projector is one of those callers ([ADR 0035](0035-head-ci-state-projection.md)): it reconciles an open `check_run` publish record on a terminal item. Crash and unpublished runs conclude the check as `action_required`. Published P0–P2 findings conclude it as `failure`. A leased-type item that stays `running` past `PR_ACTOR_LEASE_TTL_SECONDS + STALE_QUEUED_WORK_GRACE_SECONDS` with a lapsed lease and no live pg-boss job is marked `failed` (`worker_lost`) on the diagnostics tick, then the crashed verdict is closed. The same tick retries close for a terminal review whose recorded check conclusion is still missing. pg-boss retry exhaustion is not enough on its own: a hard crash can leave the row `running` after the job budget is gone.

## Consequences

Amendment for review reliability:
[ADR 0044](0044-review-validated-artifact-recovery.md) adds default-off validated
artifact recovery without changing retry scheduling, limits, or deadlines.
Receipt-only reconciliation remains reachable at the cap, but resumed workspace,
evidence rereads, read-tool, and model work charge memoized admitted `beginAttempt`.
A typed `github.review_thread_resolution_denied` is terminal verification denial,
not an ambiguous provider-text error. Its child-only nonacceptance does not undo
accepted sibling effects; parent completion needs exact operation receipts.

Cancellation/supersession telemetry follows a winning committed terminal write,
including intake. Dispatch abort or lease loss alone emits nonterminal execution
stop metadata. Audit and PostHog are independent, and no historical telemetry is
backfilled. This amends decision 6's exclusion of intake lifecycle terminals.

Amendment to decision 7: concurrent closes select one durable review verdict
before publication, including acknowledgement. Null and omitted epochs require
terminal work; numeric epochs keep their live fences. Repair retains that
selection and applies only missing required surfaces. The completion parent can
recover the exact selected child finish result; proven local/provider
preacceptance remains retryable. Unknown and cached terminal-unknown outcomes
are not reopened. Retry budgets and dispositions are unchanged. Legacy
unreconstructible completion evidence stays unresolved rather than remutated.

- The lost-running failure write rechecks age, lease expiry, and live jobs in a fresh statement after excluding concurrent lease/job writes ([ADR 0030](0030-pr-actor-lease.md)). Contention or a protected-query timeout leaves work unchanged for a later pass. Only a committed mark permits a candidate's crashed verdict close; revived work stays running. Already-terminal reviews retain the separate open-check repair lane.
- A deterministic failure costs at most one extra attempt; the second identical failure is terminal without waiting out the queue budget.
- Escalation rate and degradation reasons are observable from PostHog without reading run transcripts.
- Provider transport retry is operator-tunable and its backoff is bounded by startup validation against `PROVIDER_PROMPT_TIMEOUT_MS`.
- The fallback model is exercised only by escalation, so a fallback misconfiguration surfaces on the second attempt of a retried item.
- A completed work item never emits a failure event; partial publishes are `outcome=degraded` on `"work completed"`.
- Attempts after a retry keep every privilege boundary of attempt 1, so escalation cannot widen repository or tool access.
- A required `PR Agent Review` check does not stay in progress after retry exhaustion or a lost worker. Crash and findings are different conclusions.

## Reversal

Drain/stop affected workers and deploy them together; mixed versions still
charge lifecycle claims. Web intake and schema do not change. Keep historical
counts, terminal rows, work, lease, intent, publish and artifact data without
refunds or automatic reopening. A coordinated rollback to claim charging
restores future budget burn and does not preserve the corrected guarantee.

For a verification downgrade, pause active and queued execution first so old
workers cannot consume a new terminal denial. Disabling a feature alone does
not block retained queued work. Artifact rollback disables recovery and retains
rows and receipts; it never drops the table or resets accepted intents.

Restore `fallbackClassification.ts` and the orchestrator restart, drop the disposition and escalation plumbing, and re-emit per-feature failure events. This would reintroduce mid-run model switching and failure events for completed work items, so it is not recommended.
