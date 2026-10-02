# Development guide

Module layout, import rules, and the runtime topology diagram rubric for **pr-agent**. Agent index: [AGENTS.md](../AGENTS.md). Cursor Cloud VM setup: [cursor-cloud.md](cursor-cloud.md). Maintainer-local Compose is [docker-compose.dev.yml](../docker-compose.dev.yml) (Postgres, Caddy, web, worker, and a Cloudflare quick tunnel).

Binding review rules live in [`.pr-agent/*.mdc`](../.pr-agent/). This guide indexes areas and links those rules. Do not restate `.mdc` bodies here. Author or refresh them with [`skills/authoring-pr-agent-rules`](../skills/authoring-pr-agent-rules/SKILL.md).

Lifecycle claim and feature admission have separate owners:
`workItemStateRepository.ts::claimWorkForExecution` records lifecycle ownership
without charging. `beginWorkAttempt` locks the exact lease, then the item in a
separate statement, and atomically checks/increments the work budget.
`durableJob.ts` memoizes `env.beginAttempt()` per dispatch and exposes the latest
claim/escalation. Every executor calls it before fresh workspace/computation or
bulk patch work, after its recovery-only branches. No remote work runs under
the admission transaction. Resumed substantive work charges again.

Review recovery accepts a completed summary's `lightweightCompletion: true`
only when that record belongs to the current work item. It repairs the verdict
before fresh admission. An ordinary or foreign summary cannot select this path.

## Module layout (production)

| Area                                      | Path                                          | Public entry                                                                                                                                                                                                                                                                             |
| ----------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Review run + publish                      | `src/review/`                                 | `orchestrator/orchestratorRun.ts`, `publish/publishSummaryOnly.ts`, `publish/publishFindingBatch.ts`, `ci/analyzeCi.ts` (facts-only), `ci/authorCiSummary.ts` (LLM CI author, called from the projector), `ci/classifySnapshot.ts` (facts + rollup); metrics/footer helpers under `run/` |
| Local PR workspace                        | `src/prWorkspace/`                            | `index.ts` (`withPrRepositoryView`); `workspaceResource.ts` owns temp-root allocation, ownership marker/heartbeat, credentials, and idempotent release                                                                                                                                   |
| Code index (optional FTS)                 | `src/codeIndex/`                              | `chunker.ts` (linear per-line recognition), `buildJob.ts`, `search.ts`, `repository.ts`                                                                                                                                                                                                  |
| Agent work intake                         | `src/agentWork/intake/`                       | `planner.ts` (pure), `applier.ts` (Postgres + pg-boss), `webhookEvents.ts` (shared dedupe and transactional duplicate metadata)                                                                                                                                                          |
| Agent work execution                      | `src/agentWork/executors/`                    | individual executor files imported by `worker.ts`; `closeOwnVerdict.ts` is the only writer for `PR Agent Review` and optional `pr-agent/review`; `prHeadCiState.ts` owns `pr_head_ci_state` reads and writes                                                                             |
| Web / worker layers                       | `src/agentWork/runtime.ts`, `worker.ts`       | `agentWorkWebLive` (web); `agentWorkWorkerLive` (worker-only import graph)                                                                                                                                                                                                               |
| Ask / description / verification / triage | `src/agent/`                                  | `ask/askRun.ts`, `description/descriptionRun.ts`, `verification/verificationRun.ts`, `triage/` (executor also under `src/agentWork/executors/`)                                                                                                                                          |
| Pi session seam                           | `src/agent/runtime/`                          | `piSession.ts` (`createPiSession`; the fake adapter is not used by feature harnesses); `createFeaturePiSession` resolves the attempt's model and wraps `send` so sessions keep checkpoint/snapshot persistence — feature harnesses must not import raw Pi SDK sessions or `runAgentLoop` |
| PR surface seam                           | `src/github/`                                 | `prSurface.ts` (`createPrSurface`, `createFakePrSurface`); leased mutation recovery is `recoverPrSurfaceMutation.ts` — worker/feature code must not import `prSurfaceImpl.ts` or thread installation tokens                                                                              |
| Agent tool outputs                        | `src/agent/tools/`                            | `toolOutputBudget.ts`, `localWorkspaceTools.ts`, `codeIndexTools.ts`, `context7Tools.ts`; review sessions fence results with `wrapUntrustedEvidence` in `src/review/run/reviewRunSetup.ts`                                                                                               |
| Code Mode                                 | `src/agent/codemode/`, `src/agent/execution/` | `execute({ code })` QuickJS cell; `guestCatalogue.ts` generates the installed `tools.*` signatures for the execute description and role prompts; terminal submit/publish tools stay native siblings                                                                                      |
| Outbound security                         | `src/security/`                               | `redactOutboundSecrets.ts`, `context7OutboundPolicy.ts`                                                                                                                                                                                                                                  |
| Analytics facade                          | `src/analytics/`                              | `index.ts` (`initAnalytics`, `captureEvent`, `captureException`, `shutdownAnalytics`); `workCompleted.ts` (`work completed`, `webhook received`, `work item retried`, `ci state changed`); `workSpan.ts` (`$ai_generation` / `$ai_span`)                                                 |

Review, ask, description, and verification take the prepared Local PR workspace object. Verification derives the Pi session working directory from `workspace.agentCwd` and uses that object's `grepLiteral` and cached PR-patch diffs. It does not keep a second string checkout path.

Public entries and placement-import rules: [`.pr-agent/module-layout.mdc`](../.pr-agent/module-layout.mdc). ESM `.js` imports and settings barrel: [`.pr-agent/esm-imports.mdc`](../.pr-agent/esm-imports.mdc).

Within intake, `workItemRepository.ts` owns atomic slash winner resolution and
the ID-pinned triage payload lookup, plus provider-ordered review lifecycle
state; `applier.ts` and `slashIntake.ts` read that state under the shared review
intake lock before admission. `slashIntake.ts` owns acknowledgements.
`reviewReschedule.ts` takes that same lock, reads lifecycle in a separate statement,
then locks the parent lease and item before creating a stale-head replacement.
Closed/merged refusal precedes marker persistence and progress ownership transfer.
`createReviewRescheduleWorkItem` merges replacement payloads atomically on an
identifier conflict. Stored child values win over replayed parent values; missing
incoming fields are added. This preserves intervening changes across lease epochs.
Slash intake's value-preserving conflict update retains the winner's row lock through
commit. `/verify`'s earlier active-work precheck remains nonlocking. Review
advisory ordering and execution-time PR actor leases remain separate contracts.
`askIntake.ts` owns same-mention agreement: it serializes the triggering
comment identity on a transaction-scoped advisory lock and joins a retained
ask row in any status before quota admission, while `workItemRepository.ts`
keeps the per-webhook-event insert conflict as the idempotency backstop.

`gitGrepWorkspace` in `src/prWorkspace/localPrWorkspace.ts` runs literal `git grep -nF -I -z` and applies result and stdout-byte limits after parse. Debian bookworm Git 2.39.x in the application image is enough; the helper does not pass `--max-count`.

`durableJob.ts` owns the leased `PrSurface` publication fence: reread durable
cancellation at entry and in the final callback, then reassert the epoch before
the signal-checked mutation. Terminal hooks bypass only the durable cancellation
read to preserve verdict cleanup. Gate failures before delegation remain
retryable; after delegation, existing provider acceptance rules apply.
See [ADR 0026](adr/0026-pr-surface-seam.md).

`summaryCommentUpsert.ts` serializes revisioned progress/summary upserts under
the resource/lens advisory lock, from the fresh remote read through the result
record. Its repository calls use the locking client, without an open transaction
across HTTP. Shared progress/verdict admission in `src/db/sessionLock.ts` leaves
at least half the connections for nested
mutation checks and unrelated database work; contended clients are released
before bounded backoff. The holder keeps its client until GitHub settles.
Acquisition failures prove nonacceptance, but
delegated mutation and post-write errors retain existing acceptance rules.
CI projection and direct edits do not share this lock.
See [ADR 0020](adr/0020-orchestrated-review.md).

`src/db/sessionLock.ts` also owns verdict try-locks, bounded progress waiting,
client release before backoff, and unlock/release error precedence.
`withSessionLock(pool, key: SessionLockKey, options, apply)` accepts only the
typed progress/wait and own-verdict/try pairs. It owns exact key encoding,
half-pool budget math, and missing-max defaults; callers cannot supply capacity.
The adapters keep domain errors and progress unlock logging. Verdict admission contention defers
without a read; SQL lock contention reads its close record on the attempted
client. Unleased verdicts retain the one-connection exception.
`src/agentWork/fencedWrite.ts::fencedWrite` owns numeric-epoch precheck/write/rejection recheck
sequencing for work-state, operation-intent, and publish-record writers.
SQL-only state writes remain SQL-only; intent merge/reconcile and verdict
enrichment retain their existing no-recheck behavior. Each writer keeps its SQL
predicates, parameter positions, and terminal/CAS exceptions.

`workItemStateRepository.ts::markQueuedWorkCancelled` also covers a replacement
that wins a concurrent claim. Queued attempts finish before a lease-first
transaction locks the captured replacement epoch and cancels the active row.
The token stays fixed across rereads, including queued retries.
`reviewReschedule.ts` shares this writer between registered abort and recovered
terminal-parent cleanup, without using job existence as cancellation authority.
Successful in-attempt enqueue and the terminal fallback's persisted enqueued
marker stay exempt; leftover deliveries for cancelled work no-op.
A miss logs `agent_work_replacement_cancel_failed` at
error level before rethrowing; the outer abort catch alone only warns.
Lease release and publication gating remain on the durable runner.

`workItemStateRepository.ts::markLostRunningWorkFailed` uses an explicitly
READ COMMITTED transaction. It locks the lease key before the item, taking a
SHARE table lock when the key is missing, then recursively SHARE-locks
`pgboss.job` against inserts and state changes. All acquisition is NOWAIT,
including the item's ROW EXCLUSIVE table mode and row lock. The final eligibility
UPDATE is a later statement; a locking CTE in that same statement would not
refresh its snapshot. Negative cross-table liveness reads alone cannot authorize
failure. Contention or protected-query cancellation rolls back and returns false.
Unexpected errors still reach the reconciliation warning. Transaction-local
statement and idle limits are 1,000 ms each; they are not a total transaction
deadline and do not change pool defaults. GitHub close happens only after commit.
The broad job lock can briefly delay unrelated lanes or defer recovery under
busy traffic. See [the queue runbook](agent-work-ops.md#inspect-queue-health).

`createPiSession.send` fails after a settled unrecovered Pi provider error. Recovered Core transport retries stay successful. Public cancellation, idle timeout, and tool-budget stops stay distinct from provider outages. `send` replaces the session suffix with Core's returned turn slice so tool results stay between the assistant turns that produced them.

## Landing site

The marketing site (`site/`, package `pr-agent-landing`) is a separate workspace package. It is not required to run the bot. Its visual system, tokens, and component recipes are documented in [`site/DESIGN.md`](../site/DESIGN.md); read it before changing the page's look.

Agent-facing copy lives in [`site/lib/llmsKnowledge.ts`](../site/lib/llmsKnowledge.ts). Update it and regenerate `site/public/llms.txt` alongside relevant README and docs changes without separate copy approval. The human page stays a short overview, but its App event list, permissions, and command tips must match [README.md](../README.md) and that profile. AI agents must propose the exact wording of any human-page correction and wait for explicit user approval, preserving its tone and wording otherwise. Shared constants are not an exemption from that gate. See [AGENTS.md](../AGENTS.md#public-documentation) and [site/DESIGN.md](../site/DESIGN.md#content-and-voice). Agents read `/llms.txt`, `GET /llms?query=`, and `GET /llms/json?query=`.

Every agent-facing URL is declared once in [`site/lib/agentResources.ts`](../site/lib/agentResources.ts), which renders llms.txt link lists, `robots.txt` pointers, `sitemap.xml`, `/openapi.json`, the 404 body and page, the `Link` headers, and the head's `alternate`/`describedby` links. Add an endpoint there, not in each surface; surfaces that point at one resource by identity use its named registry entry.

`/` negotiates on `Accept`. HTML is the default, `text/markdown` is served when asked, and 406 answers a header that accepts neither. The parser is [`site/lib/accept.ts`](../site/lib/accept.ts). Its sibling [`site/lib/acceptLanguage.ts`](../site/lib/acceptLanguage.ts) reads `Accept-Language` for a programming language and picks the fetch example on the markdown page. Locale tags such as `en` and `en-US` are ignored, and only full words count, so `ts`, `js`, `py`, and `sh` are read as locale tags. `golang` and `shell` are aliases. The served set is `typescript` (default), `javascript`, `python`, `go`, `java`, `ruby`, and `bash`, derived from the variant snippet in [`site/lib/content.ts`](../site/lib/content.ts). Markdown `/` varies on `Accept` and `Accept-Language`, `/index.md` varies on `Accept-Language`, and HTML `/` and the 404 vary on `Accept` only. Responses and the 404 recovery document are [`site/lib/siteHttp.ts`](../site/lib/siteHttp.ts). The request middleware that applies them is [`site/start.ts`](../site/start.ts). Every HTML section renders from the same constants as the markdown in [`site/lib/pageMarkdown.ts`](../site/lib/pageMarkdown.ts). The markdown representation also carries the agent fetch example and its language-variant fences. `/` is not prerendered. The server function must see every request for negotiation to work.

## Internal errors (`AppError`)

Production failures in `src/` use `AppError` from `src/errors/appError.ts`. Field rules, helpers, domain subclasses, and the AppError-never-on-PR rule: [`.pr-agent/structured-errors.mdc`](../.pr-agent/structured-errors.mdc). `serializeAppError` and `errorLogFields` are the canonical sanitized representation for telemetry; evlog, analytics, PostHog, and startup logging sanitize Error values and metadata again at their boundaries, so callers do not need to pre-sanitize contexts or causes.

## Prompt prose

Long investigator prompt blocks stay in prompt modules. Correctness uses `src/review/prompts/reviewSystemPrompt.ts`. Security, quality, and tests personas live under `src/agent/prompts/`. Only numeric limits and shared user-visible strings belong in `src/settings/*Constants.ts`. Binding rule: [`.pr-agent/prompt-vs-constants.mdc`](../.pr-agent/prompt-vs-constants.mdc). The correctness persona prompt includes an ordered risk-directed investigation method; its high-signal bug-pattern list remains supporting recognition. Code Mode roles also include a generated guest-capability catalogue from `src/agent/codemode/guestCatalogue.ts` in the stable prefix. That list is the installed `tools.*` set for that role, not the bug-pattern list. Description and triage keep native workspace tools and do not receive `execute`. CI summary and bound-policy judgment are no-tool JSON turns. Inspect a persona's generated prompt with `nub run dump-prompt <persona>` (`scripts/dump-prompt.ts`); prompt changes are proven by inspected prompt output, not `check:code` alone.

`nub run dump-prompt all` emits deterministic JSON for every role's system prompt
and ordered tool definitions, including native workspace definitions hidden by
Code Mode and the compaction prompts. It constructs definitions without running
tools, creating sessions, or contacting providers. Compare its complete output
before and after a refactor; an empty diff protects the stable prefixes from
[ADR 0025](adr/0025-prompt-cache-stability.md), not provider cache hit rates.
The persisted-identity golden cases and module deletion verdicts are recorded in
[ADR 0043](adr/0043-deep-module-map.md).

Concrete modules own the M1 interfaces. Workspace callers import
`prRepositoryView.ts`, `localPrWorkspace.ts`, or `writablePrCheckout.ts` directly.
Code Mode imports execution sessions, pooling, and marshalling from their concrete
execution modules; cross-worker halt codes and encoding live in
`src/agent/execution/hostHalt.ts`. `PrResource`, `PrRef`, and `ReplyTarget` live in
`src/agentWork/types.ts`. `PrSurface` requires bot-login, published-batch, and
review-check reads; implementations cannot omit those recovery capabilities.
Review status phrases live in `src/review/statusCopy.ts`, CI action phrases in
`src/review/ci/ciSummaryCell.ts`, and specialist prompt selection in
`src/review/orchestrator/specialistRun.ts`. Helpers with one owner stay private
there; existing tests exercise their observable publication or execution output.

## Static guards and generated maps

`nub run lint` and `nub run lint:backend` require zero warnings (`--deny-warnings`). The static baseline also counts `(oxlint|eslint)-disable` markers under `lint-suppressions(src)` (5) and `lint-suppressions(test)` (0). These counts may shrink, not grow.

Machine law lives in scripts plus tests, enforced by `nub run check:guards` (CI `check` job): `scripts/check-static-baseline.mjs` with `scripts/baselines/static-baseline.json` (fail-on-growth violation counts; bootstrap with `--bootstrap`, never under `CI=true`), `scripts/check-comments.mjs` (justification markers), `scripts/check-domain-guards.mjs` (console allowlist, migration numbering, `escape()` cross-check, site parity, AGENTS.md path drift). The single sanctioned cast is `escape()` in `src/util/escape.ts` ([ADR 0038](adr/0038-fail-on-growth-static-baseline.md), [ADR 0039](adr/0039-single-blessed-assertion-escape.md)). Architecture edges are rows in `test/architectureRules.test.ts` with walkers in `test/architectureRulesHelpers.ts` ([ADR 0040](adr/0040-in-repo-import-ruleset.md)). `docs/feature-map.md` is generated by `nub run gen:feature-map` and asserted by `test/featureMap.test.ts` ([ADR 0041](adr/0041-generated-feature-map.md)). Scaffold migrations with `nub run gen:migration <snake_slug>`. Prove the durable path with `nub run verify` (disposable Postgres, artifact under `verify-artifacts/`).

## Tool-round budgets

Every `session.send` that can call tools passes `maxToolRounds`. Investigation turns use their role budget (`MAX_TOOL_ROUNDS`, `MAX_TOOL_ROUNDS_TRIAGE`, and so on), which escalated retries scale. Judgment turns use `ORCHESTRATOR_JUDGMENT_MAX_TOOL_ROUNDS` evidence rounds plus one reserved publish round (at most one extra round); windowed re-reads confirming a line use evidence rounds and never gamble the reserved `publish_thread` slot. A turn whose only job is to call a submit tool is a submit-only turn and uses `SUBMIT_ONLY_MAX_TOOL_ROUNDS` (one submit plus one in-turn correction). Escalation does not scale it. Send it through `runSubmitOnlyRound`, or pass the constant directly as the orchestrator does for recon repair, synthesis, synthesis repair, and summary recovery. A finalize turn that may still do real work, such as triage `commitFix`, is not submit-only and keeps its role budget. The returned turn's `end` is `tool_budget` when the budget stopped the loop.

## Runtime topology diagram

When a change alters **runtime topology**, update the Mermaid diagram in [AGENTS.md](../AGENTS.md) How it works in the same PR. Binding rule: [`.pr-agent/topology-diagram.mdc`](../.pr-agent/topology-diagram.mdc).
