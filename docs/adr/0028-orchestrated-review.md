# ADR 0028 — Orchestrated review with specialist subagents

## Status

Accepted. Supersedes [ADR 0006](0006-security-review-summary-sentinel.md) and [ADR 0016](0016-review-quality-lens.md). Affects [ADR 0011](0011-review-pointer-link.md) (pointer link is single-mode) and [ADR 0005](0005-structured-review-output.md) (`ReviewPayload` survives as the summary-tool contract). Related (not superseded): [ADR 0009](0009-durable-agent-work.md) (one review singleton key per PR), [ADR 0014](0014-lightweight-review-completion.md) (trivial exemption still skips a full run), [ADR 0018](0018-triage-autofix-work-type.md) (triage inventory includes specialist threads plus legacy lenses), [ADR 0027](0027-agent-instruction-files.md) (instruction files load once per orchestrated run).

## Context

Four independent review lenses (`/review`, `/review-security`, `/review-quality`, `/review-tests`) each re-explored the PR from a cold start. That wasted context, delayed first inline feedback until the slowest full run finished, and produced shallow specialist findings because each subagent spent budget re-discovering architecture. Operators also maintained multiple check-run names and summary sentinels per PR.

Issue [#319](https://github.com/prathamdby/pr-agent/issues/319) replaces that model with one **orchestrated review run**: a long-lived **review orchestrator** recons once, briefs four parallel **specialists**, publishes **thread batches** as reports arrive, and synthesizes the final summary only after every specialist resolves.

## Decision

Locked decision IDs from #319 (body 1–15, edge-case addendum 16–27). Grouped by theme; each bullet keeps its original issue number (unordered list so formatters cannot renumber).

### Product shape (1–5, 11)

- **1.** All four lenses merge into one review; specialists replace lenses.
- **2.** One LLM session does recon, brief authoring, per-report judgment, and final synthesis.
- **3.** The orchestrator judges each finding and publishes via `publish_thread`; the deterministic layer validates, anchors, and suppresses.
- **4.** Fixed specialist roster every run: correctness, security, quality, tests (reborn from the ex-lens investigation prompts).
- **5.** Only `/review` remains; `/review-security`, `/review-quality`, `/review-tests` are removed (unknown-command reply).
- **11.** Rollout replaces V1 outright on the feature branch: no feature flag; lens-specific run loops deleted.

### Specialist contract (6–8, 22, 24)

- **6.** Specialist system prompt = persona instructions; first user message = orchestrator **specialist brief** (two-prompt warm-up).
- **7.** Reports carry explicit `status: "no_findings"`; empty runs are silently skipped (stub tick only), never treated as failure.
- **8.** Error runs: one fresh-session retry; then partial publish + coverage-partial note in the stub tick and final summary.
- **22.** All four specialists `no_findings` keeps zero-findings semantics: synthesis still runs, empty findings table, check run success (no findings-derived failure; incremental batches remain `COMMENT` when present).
- **24.** Specialist spawns are staggered (`SPECIALIST_DISPATCH_STAGGER_MS`, 2s per index) to avoid a five-way provider burst (one orchestrator session plus four specialist sessions). Errors classified as rate-limit/timeout retry with backoff without consuming the fresh-session retry from decision 8; total attempts capped at 3.

### Publish timing and batches (9–10, 15–16, 23, 25)

- **9.** Final summary (stub → table edit), labels, check run, and commit status land only after all specialists resolve.
- **10.** Deterministic **specialist tick** after every specialist resolution.
- **15.** Every incremental inline batch posts as GitHub review event `COMMENT`. The findings-derived conclusion is computed once for the final check run and optional commit status; no final GitHub review verdict event (`APPROVE` / `REQUEST_CHANGES`) is created. Notification volume (one `COMMENT` review event per batch, up to ~5 author notifications per run vs 1 historically) is an accepted consequence.
- **16.** Multi-batch durability keeps **one** `inline_review` publish-record row. Each batch atomically appends `{reviewId, fingerprints, event, url, counts}` to a `batches` JSONB array (SQL-side merge). No migration.
- **23.** Cross-specialist near-duplicates: LLM judgment is the dedupe layer; fingerprint suppression also checks adjacent line buckets; `publish_thread` returns same-file overlap hints. No text-similarity auto-suppression.
- **25.** Prompt contract: one `publish_thread` per judgment turn (`MAX_THREAD_PUBLISH_CALLS` = 8 allows repair). After `budget_exhausted`, later findings join `acceptedFindings` as summary-only rows — never silently vanish.

### Deadline, abort, degrade (17–19, 26–27)

- **17.** Hard run deadline = `queueExpireInSeconds × 0.8` (`RUN_DEADLINE_BUDGET_FRACTION`). Specialist timeout is `min(REVIEW_SPECIALIST_TIMEOUT_MS, remaining budget minus that specialist's start stagger)`. Invariant: the handler returns before pg-boss can fail + redeliver.
- **18.** `abort()` is on `AgentRunnerSession`. The pump aborts pending specialists and disposes the orchestrator when `shouldContinue()` flips or the deadline hits. Cheap cancel poll is 250ms (`ORCHESTRATOR_SEND_ABORT_POLL_MS`) and never hits the full stale-head GitHub gate.
- **19.** Orchestrator session death: retry the failing `send()` once; on second failure, degrade deterministically — unjudged reports flow through `publishFindingBatch`, summary renders from `acceptedFindings` with a judgment-degraded note. A summary always lands when any coverage remains.
- **26.** Stale head / superseded mid-pump: first abort stops the pump, aborts all sessions, skips synthesis, writes a terminal superseded stub tick, then hands off to existing reschedule/skip-publish paths. No findings reuse across heads.
- **27.** Every orchestrated-review GitHub write reads `getToken()` from the live holder and refreshes when near expiry before publish/tick (no timers).

### Check / status (20–21)

- **20.** `ciRefreshExecutor` yields while an active review work item exists for that PR; the run’s final summary re-renders CI.
- **21.** Any failed specialist forces check run conclusion **neutral** (partial note) and commit status **error**. Findings-derived success/failure applies only under full coverage. A green `PR Agent Review` always means all four specialists ran.

### Legacy compatibility (12–14)

- **12.** No destructive DB migration. `review_lens` stays; code only writes `'review'`. Legacy values remain parse-valid.
- **13.** New fingerprints hash under mode `"review"`; suppression also computes candidates under the three legacy modes.
- **14.** Parsers for legacy sentinels, pointer-lens markers, and review-meta markers stay (quarantined) so historical PR comments remain recognized by prior-feedback, triage, and CI refresh.

## Consequences

- Branch protection must require **`PR Agent Review`** only; per-lens check names are gone.
- One active review slot per PR (slash dedup); no concurrent lens runs.
- N GitHub reviews per run (one per **thread batch**) plus the final summary/pointer surfaces.
- One-time fingerprint-mode change is mitigated by legacy candidates so old inline threads are not reposted.
- Operators see earlier inline feedback; summary still waits for the slowest specialist (or degrade/deadline path).
- Vocabulary and topology docs: [CONTEXT.md](../../CONTEXT.md), README How It Works, [configuration.md](../configuration.md), [operations.md](../operations.md).

## Reversal

Restore per-lens slash commands and independent runs only with a new ADR; do not silently revive retired sentinels as active write paths.
