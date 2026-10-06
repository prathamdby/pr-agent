# Development guide

Module layout, import rules, and the runtime topology diagram rubric for **pr-agent**. Agent index: [AGENTS.md](../AGENTS.md). Cursor Cloud VM setup: [cursor-cloud.md](cursor-cloud.md). Maintainer-local Compose is [docker-compose.dev.yml](../docker-compose.dev.yml) (Postgres, Caddy, web, worker, and a Cloudflare quick tunnel).

Keep root `AGENTS.md` below the binding loader's 32 KiB file limit. Use pointers
to this guide and the runbooks instead of duplicating their detail.

Binding review rules live in [`.pr-agent/*.mdc`](../.pr-agent/). This guide indexes areas and links those rules. Do not restate `.mdc` bodies here. Author or refresh them with [`skills/authoring-pr-agent-rules`](../skills/authoring-pr-agent-rules/SKILL.md).

Lifecycle claim and feature admission have separate owners:
`workItemStateRepository.ts::claimWorkForExecution` records lifecycle ownership
without charging. `beginWorkAttempt` locks the exact lease, then the item in a
separate statement, and atomically checks/increments the work budget.
`durableJob.ts::createDurableExecutionContext` memoizes `env.beginAttempt()` per dispatch and exposes the latest
claim/escalation. Every executor calls it before fresh workspace/computation or
bulk patch work, after its recovery-only branches. No remote work runs under
the admission transaction. Resumed substantive work charges again.

`workItemTransitions.ts::transition` is the only writer of
`agent_work_items.status` (`scripts/check-domain-guards.mjs` rejects a raw status
`UPDATE` anywhere else in `src/`). A caller supplies its selector (id, or resource
key with type or lens), the statuses it may leave, the target (`WorkStatus`
literals, never strings), and the guards that decide a race: `unlessCancelRequested`,
a numeric `leaseEpoch` fence, and extra `where` predicates. Terminal targets stamp
`completed_at`, `running` stamps `started_at`, and `lockPrior` reads the prior
status `FOR UPDATE` for the claim. A lost race changes zero rows and reports
`rowCount` 0; the repositories keep their domain wrappers (`markWorkCompleted`,
`markWorkFailed`, `cancelActiveReviews`, auto-work supersede) and add no SQL of
their own for status. The cancel-request-only write in `autoWorkEnqueue.ts` keeps
status `running`, so it is not a transition.

`ciProjection.ts::requestHeadCiProjection` is the only way to ask for a
`ci-projection` job. Its schedule is `intake` (debounced inside the caller's
transaction, keeping the delivery identity in `correlations`), `debounced` (the same
5s slot without a transaction), `after` (one deferred job for rate-limit or
pending-refresh retry), or `when_due` (a claim-time writer asks only when the head
still needs a seed or its row moved past the rendered version). Job names, the
`owner/repo:headSha` singleton key, and the `:deferred` key are unchanged.

Review recovery accepts a completed summary's `lightweightCompletion: true`
only when that record belongs to the current work item. It repairs the verdict
before fresh admission. An ordinary or foreign summary cannot select this path.

`src/agentWork/publishOnce.ts` owns mutation intent sequencing and scoped
completion evidence. `createPublishContext` binds the work item, resource, lens,
and epoch before reading or recording a step. Postgres and the production fake
adapters share the publication persistence interfaces. Triage's publisher selects
stored push evidence itself; orchestration no longer fabricates a checkout.

Review artifact recovery has separate owners:
`src/review/recovery/reviewArtifacts.ts` validates/redacts structured output,
versions contracts, and binds effective input identity;
`src/agentWork/reviewArtifactRepository.ts` fences active writes lease-first,
serializes the per-work 1 MiB UTF-8 budget, reserves 8 KiB per prepared decision,
and enforces idempotent keys and ordered dependencies. It is not generic session
storage. Flag gating and effective-input digest assembly belong to the review
consumer. Prepared plans retain full canonical ledger decisions/footers; bounded
settlement refers to them and never substitutes for exact remote receipts.
`findings/evidenceLedger.ts::revalidateEvidenceDescriptors` stages coverage until
all fresh governed range reads match. See [ADR 0044](adr/0044-review-validated-artifact-recovery.md).

Runtime-session and send UUIDs are telemetry identity, not prompt-cache identity.
`src/traces/recorder.ts` owns bounded best-effort local recording and execution
AsyncLocalStorage; execution counters and recorder state stay private.
`src/agent/runtime/sessionTrace.ts` projects Pi events into session, per-call
generation, tool and compaction children behind an always-present, nonthrowing
observer. `AgentWorkExecutionsLive(cfg)` owns the injected dedicated trace pool
and its bounded drain and socket cleanup. SQL and retention
belong to `src/agentWork/agentTraceRepository.ts`; credential-only content redaction
belongs to `src/traces/content.ts`. Traces never authorize recovery or publishing.
See [ADR 0046](adr/0046-agent-traces.md).
`agentEventSink.ts` fans out independently to optional local audit and PostHog;
missing generation usage remains absent. Specialist schema/validation/run spans
are non-generation stages emitted as they settle. Durable terminal capture follows
the winning committed state write; an execution stop has no terminal authority.
Structured failure origins and lifecycle boundaries outrank wrapper wording.
Typed thread-resolution denial is child-only nonacceptance, and verification
recovery requires exact operation completion receipts rather than resource history.

## Module layout (production)

`src/github/installationCapabilities.ts` owns validated available/denied/unknown
operation grants and endpoint permission alternatives.
`installationSurface.ts` owns fresh bounded repository preflight and managed
token resolution. `src/agentWork/githubCapabilityRepository.ts` owns ordered
scoped observations, CI source restoration/revisions, retention, and lease-fenced
preflight counters. No capability record contains credentials.
`durableJob.ts` prepares authentication before real head/receipt recovery;
`runReviewForWorkItem.ts` gates only new work after exact completion evidence.
`reviewVerdict.ts` keeps immutable selected output and independent
applied/skipped-for-this-run/blocked/unresolved surface applicability.
Optional reads and writes are run-scoped, never shared-config changes.

| Area                                      | Path                                            | Public entry                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Review run + publish                      | `src/review/`                                   | `runReviewForWorkItem.ts` (feature entry: context, session, publish, terminal outcome), `orchestrator/orchestratorRun.ts` (step loop; `orchestrator/runStep.ts::nextStep` picks each step), `publish/reviewPublishSession.ts`, `publish/publishSummaryOnly.ts`, `publish/publishFindingBatch.ts`, `ci/ciFacts.ts` (snapshot types, rollup, facts-only summary, authored cache), `ci/ciAuthor.ts` (log intake and condensing, LLM CI author called from the projector), `ci/ciSummaryCell.ts` (cell render, CI and verification markers); metrics/footer helpers under `run/`      |
| Local PR workspace                        | `src/prWorkspace/`                              | `prRepositoryView.ts` (`withPrRepositoryView`); `localPrWorkspace.ts` owns pinned preparation and cleanup; `repositoryReader.ts` owns pinned/writable readers, path policy and Git execution; `workspaceResource.ts` owns allocation, heartbeat, credentials and release                                                                                                                                                                                                                                                                                                          |
| Code index (optional FTS)                 | `src/codeIndex/`                                | `chunker.ts` (linear per-line recognition), `buildJob.ts`, `search.ts`, `repository.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Agent work intake                         | `src/agentWork/intake/`                         | `delivery.ts` (`runDelivery`, `DeliveryTx.withReviewIntake`, shared dedupe and post-commit events); `src/webhook/intakeCommand.ts` owns pure event mapping                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Agent work execution                      | `src/agentWork/workDefinition.ts`, `executors/` | `createWorkDefinitions` owns the closed kind/queue/lease/head/context table and execution/terminal hooks consumed by `worker.ts`; `leasedExecution.ts::openLeasedExecution` owns lease ordering, watchdog seeding, and fenced terminal marks; `durableJob.ts` owns admission, retry policy, and post-mark completion capture; executors return closed `WorkCompletion` values; `../reviewVerdict.ts` owns pending checks, one close writer, and open-check repair for `PR Agent Review` and optional `pr-agent/review`                                                            |
| Web / worker layers                       | `src/agentWork/runtime.ts`, `worker.ts`         | `agentWorkWebLive` (web); `agentWorkWorkerLive` (worker-only import graph)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Ask / description / verification / triage | `src/agent/`                                    | `ask/askRun.ts`, `description/descriptionRun.ts`, `verification/verificationRun.ts`, `triage/` (executor also under `src/agentWork/executors/`)                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Pi session seam                           | `src/agent/runtime/`                            | `piSession.ts` (`createPiSession`); `createFeaturePiSession` resolves model and lifecycle policy and accepts an injected session adapter. `featureAgent.ts` shares submit/repair ordering for description, verification, and triage; the fake adapter exercises it through injection. Review receives `createSession` through `WorkExecutionDependencies` and passes it to every orchestrator and specialist session; `rateLimitCircuit.ts` (`openRunRateLimitCircuit`) opens the per-run GitHub circuit for review and ask. SDK construction and provider registration stay here |
| PR surface seam                           | `src/github/`                                   | `prSurface.ts` (`createPrSurface`, `createFakePrSurface`); leased mutation recovery is `recoverPrSurfaceMutation.ts` — worker/feature code must not import `prSurfaceImpl.ts` or thread installation tokens                                                                                                                                                                                                                                                                                                                                                                       |
| Installation execution surface            | `src/agentWork/installationSurface.ts`          | `openInstallationSurface` owns App/private-key/installation-scoped auth caches and surface creation for durable work, auxiliary lanes, and code-index builds; injected production and fake adapters share that policy                                                                                                                                                                                                                                                                                                                                                             |
| Agent tool outputs                        | `src/agent/tools/`                              | `toolOutputBudget.ts`, `workspaceToolset.ts` (`buildWorkspaceTools`, ordered investigation/verification/triage read profiles), `codeIndexTools.ts`, `context7Tools.ts`; review sessions fence results with `wrapUntrustedEvidence` in `src/review/run/reviewRunSetup.ts`                                                                                                                                                                                                                                                                                                          |
| Code Mode                                 | `src/agent/codemode/`, `src/agent/execution/`   | `execute({ code })` QuickJS cell; `guestCatalogue.ts` generates the installed `tools.*` signatures for the execute description and role prompts; terminal submit/publish tools stay native siblings                                                                                                                                                                                                                                                                                                                                                                               |
| Outbound security                         | `src/security/`                                 | `redactOutboundSecrets.ts`, `context7OutboundPolicy.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Analytics facade                          | `src/analytics/`                                | `index.ts` (`initAnalytics`, `captureEvent`, `captureException`, `shutdownAnalytics`); `workCompleted.ts` (`recordWorkCompleted`, called only by the durable runner after a winning mark; `webhook received`, `work item retried`, `ci state changed`); `workSpan.ts` (`$ai_generation` / `$ai_span`)                                                                                                                                                                                                                                                                             |

Review, ask, description, and verification take the prepared Local PR workspace object. Verification derives the Pi session working directory from `workspace.agentCwd` and uses `workspace.reader` for bounded reads, literal search and cached PR-patch diffs. It does not keep a second string checkout path.

Durable executors acquire read-only views through
`env.withAdmittedRepositoryView(options, run)`. The execution context binds PR
identity, credentials, and head, and awaits its memoized admission before view
preparation. Lightweight review and verification's bulk reads use that same
`env.beginAttempt`. `env.durability` carries session identity without owning
snapshot storage. `env.shouldAbortPublish` checks signal, durable cancellation,
and lease ownership in that order. Review adds its live-head predicate; triage
keeps its separate writable checkout and closed-PR commit/push guards.

The Pi session public interface stays in `src/agent/runtime/types.ts`.
`piSessionImpl.ts` owns setup, phase/protocol gates, lifecycle and usage projection,
and final outcome precedence. Internal `turnToolBudget.ts` keeps Core's
finish-before-event counting and reserved terminal allowance together.
`sessionTurnLoop.ts` owns transcript order and capped retry continuation;
`sessionCompaction.ts` owns window and overflow compaction policy.
`sendActivity.ts` owns each send's inactivity monitors and abortable retry waits,
and releases all acquired timers when that send finishes. The existing
`createPiSession.test.ts` and seam/compaction suites exercise this through the
unchanged public adapter.

`Config` is nested slices (`runtime`, `github`, `webhook`, `associations`, `features`, `models`, `provider`, `agentEvents`, `traces`, `findingHistory`, `codeIndex`, `codeMode`, `review`, `concurrency`, `ask`, `queue`, `retention`, `context7`, `posthog`, `logging`). Each slice reader lives in `src/settings/slices/` and uses the typed readers in `src/settings/envReaders.ts`, the only `NODE_ENV` read. `src/settings/config.ts` composes them and its `loadConfig` stays the single entry; the settings barrel exports it. A module takes the slice it needs (`Config["ask"]`, `Pick<Config, "features">`). Code Mode receives `executorKind` as a parameter from `cfg.codeMode.executorKind`; nothing reads `VITEST`. Tests build slices with `makeTestConfig({ review: { maxInlineComments: 1 } })` and pass them in; settings are never module-mocked. The Pi model catalog (`modelsJson*`) lives in `src/agent/runtime/`; the worker-role models slice loads it with a dynamic import so web never loads the Pi SDK.

Public entries and placement-import rules: [`.pr-agent/module-layout.mdc`](../.pr-agent/module-layout.mdc). ESM `.js` imports and settings barrel: [`.pr-agent/esm-imports.mdc`](../.pr-agent/esm-imports.mdc).

Within intake, `workItemRepository.ts` owns atomic slash winner resolution and
the ID-pinned triage payload lookup, plus provider-ordered review lifecycle
state; `DeliveryTx.withReviewIntake` acquires the shared review intake lock,
then reads that state in a separate statement before admission. Automated,
slash, approval, and lifecycle decisions are final at event insertion. `slashIntake.ts` owns acknowledgements.
`reviewReschedule.ts` takes that same lock, reads lifecycle in a separate statement,
then locks the parent lease and item before creating a stale-head replacement.
Closed/merged refusal precedes marker persistence and progress ownership transfer.
`createReviewRescheduleWorkItem` merges replacement payloads atomically on an
identifier conflict. Stored child values win over replayed parent values; missing
incoming fields are added. This preserves intervening changes across lease epochs.
Slash intake's value-preserving conflict update retains the winner's row lock through
commit. `/verify`'s earlier active-work precheck remains nonlocking. Review
advisory ordering and execution-time PR actor leases remain separate contracts.
`askQuota.ts::admitAsk` owns same-mention agreement, quota reservation,
matching work insertion, and conflict compensation as one delivery-transaction
operation. It locks the triggering comment identity and separately reads a
retained ask row in any status before checking quota. `askIntake.ts` owns question
parsing and queue/acknowledgement policy; `workItemRepository.ts` keeps the
per-webhook-event insertion conflict as the idempotency backstop. A losing
reservation is removed after capacity release so the deferred foreign key
cannot refer to work that was never inserted; rate debits remain unchanged.

`gitGrepWorkspace` in `src/prWorkspace/repositoryReader.ts` runs literal `git grep -nF -I -z` and applies result and stdout-byte limits after parse. Debian bookworm Git 2.39.x in the application image is enough; the helper does not pass `--max-count`.

`RepositoryReader` has two production adapters: the pinned PR view and the
writable triage checkout. `PathPolicy` retains review/ask's changed-sensitive-path
gate, verification's sensitive-path refusal, and triage's sensitive/control-path
and resolved-containment checks. Tool profiles retain their distinct ordered
descriptions, schemas, wire output, spill cleanup and delivered-read evidence.
Commit attribution lives in `src/agent/triage/commitAttribution.ts`; checkout
identity validation and final commit/push guards remain at the mutation boundary.
Resource owner markers and the live-root registry are private; allocation and
sweeping are the production interface and the existing owner tests exercise them.

`leasedExecution.ts` owns the leased `PrSurface` publication fence: reread durable
cancellation at entry and in the final callback, then reassert the epoch before
the signal-checked mutation. Terminal hooks bypass only the durable cancellation
read to preserve verdict cleanup. Gate failures before delegation remain
retryable; after delegation, existing provider acceptance rules apply.
See [ADR 0026](adr/0026-pr-surface-seam.md).

`createReviewSummaryComment` in `reviewSummaryComment.ts` is the only writer of
the review summary comment: progress ticks, the terminal summary, cancelled and
failure notices, and the lightweight completion. It serializes revisioned
upserts under the resource/lens advisory lock, from the fresh remote read
through the result record. `run/commentMarkers.ts` owns the progress-revision
marker codec. Terminal writes use revision 7, so a late tick cannot replace a
summary or notice. Its repository calls use the locking client, without an open transaction
across HTTP. Shared progress/verdict admission in `src/db/sessionLock.ts` leaves
at least half the connections for nested
mutation checks and unrelated database work; contended clients are released
before bounded backoff. The holder keeps its client until GitHub settles.
Acquisition failures prove nonacceptance, but
delegated mutation and post-write errors retain existing acceptance rules.
CI projection and direct edits do not share this lock.
See [ADR 0020](adr/0020-orchestrated-review.md).

`src/agentWork/reviewVerdict.ts::reviewVerdict` returns `{pending, close, repairIfOpen}`.
It resolves summary details links and applies only the first selected verdict.
Check and commit-status acceptance retain separate receipts and fail-closed repair.
Explicit null comment IDs retain no-link output on acknowledgement, stale-head,
projector, and sweeper paths; just-written comments can supply their IDs before
a durable record exists.

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

The marketing site (`site/`, package `pr-agent-landing`) is a separate workspace package. It is not required to run the bot. Its visual system, tokens, and component recipes are documented in [`site/DESIGN.md`](../site/DESIGN.md); read it before changing the page's look. [`site/AGENTS.md`](../site/AGENTS.md) holds the agent rules for changing that system: token layers, recipe owners, DESIGN.md format, and verification. `nub run check:site-design` (CI `site` job) runs `scripts/check-site-design.mjs` against `scripts/baselines/site-design-baseline.json`: undeclared colour tokens, raw colours, primitive reads, off-scale type sizes, arbitrary values, unguarded hovers, `transition: all`, card, chip, and section-title clones, and `@theme` tokens missing from DESIGN.md. Counts only shrink; the rule table lives in [DESIGN.md](../site/DESIGN.md#verification).

Agent-facing copy lives in [`site/lib/llmsKnowledge.ts`](../site/lib/llmsKnowledge.ts). Update it and regenerate `site/public/llms.txt` alongside relevant README and docs changes without separate copy approval. The dev server rewrites that file when a watched knowledge module changes. The production build compares the committed file with `renderLlmsTxt()` and fails without rewriting it. The human page stays a short overview, but its App event list, permissions, and command tips must match [README.md](../README.md) and that profile. AI agents must propose the exact wording of any human-page correction and wait for explicit user approval, preserving its tone and wording otherwise. Shared constants are not an exemption from that gate. See [AGENTS.md](../AGENTS.md#public-documentation) and [site/DESIGN.md](../site/DESIGN.md#content-and-voice). Agents read `/llms.txt`, `GET /llms?query=`, and `GET /llms/json?query=`.

Every agent-facing URL is declared once in [`site/lib/agentResources.ts`](../site/lib/agentResources.ts), which renders llms.txt link lists, `robots.txt` pointers, `sitemap.xml`, `/openapi.json`, the 404 body and page, the `Link` headers, and the head's `alternate`/`describedby` links. Add an endpoint there, not in each surface; surfaces that point at one resource by identity use its named registry entry.

`/` negotiates on `Accept`. HTML is the default, `text/markdown` is served when asked, and 406 answers a header that accepts neither. The parser is [`site/lib/accept.ts`](../site/lib/accept.ts). Its sibling [`site/lib/acceptLanguage.ts`](../site/lib/acceptLanguage.ts) reads `Accept-Language` for a programming language and picks the fetch example on the markdown page. Locale tags such as `en` and `en-US` are ignored, and only full words count, so `ts`, `js`, `py`, and `sh` are read as locale tags. `golang` and `shell` are aliases. The served set is `typescript` (default), `javascript`, `python`, `go`, `java`, `ruby`, and `bash`, derived from the variant snippet in [`site/lib/content.ts`](../site/lib/content.ts). Markdown `/` varies on `Accept` and `Accept-Language`, `/index.md` varies on `Accept-Language`, and HTML `/` and the 404 vary on `Accept` only. Responses and the 404 recovery document are [`site/lib/siteHttp.ts`](../site/lib/siteHttp.ts). The request middleware that applies them is [`site/start.ts`](../site/start.ts). Every HTML section renders from the same constants as the markdown in [`site/lib/pageMarkdown.ts`](../site/lib/pageMarkdown.ts). The markdown representation also carries the agent fetch example and its language-variant fences. `/` is not prerendered. The server function must see every request for negotiation to work.

## Internal errors (`AppError`)

Production failures in `src/` use `AppError` from `src/errors/appError.ts`, constructed with a closed `{domain, kind}` pair declared in `src/errors/appErrorCodes.ts`. Field rules, helpers, domain subclasses, and the AppError-never-on-PR rule: [`.pr-agent/structured-errors.mdc`](../.pr-agent/structured-errors.mdc). `serializeAppError` and `errorLogFields` are the canonical sanitized representation for telemetry; evlog, analytics, PostHog, and startup logging sanitize Error values and metadata again at their boundaries, so callers do not need to pre-sanitize contexts or causes.

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
`src/agentWork/types.ts`. `PrSurface` requires bot-login, review-list, and
review-check reads; implementations cannot omit those recovery capabilities.
It exposes raw GitHub reads (`getHead`, `listReviewComments`,
`listPullRequestReviews`) and one `updatePullRequest` write; prior-feedback
thread assembly lives in `reviewPriorFeedback.ts` and description merging in
`src/agent/description/descriptionPublishPlan.ts`.
Review status phrases live in `src/review/statusCopy.ts`, CI action phrases in
`src/review/ci/ciSummaryCell.ts`, and specialist prompt selection in
`src/review/orchestrator/specialistRun.ts`. Helpers with one owner stay private
there; existing tests exercise their observable publication or execution output.

Durable definitions expose their typed `execute` and terminal hooks directly.
The worker registers their `dispatch` functions, not five executor wrappers.
`createDurableRuntime` injects the installation adapter, atomic transaction,
lease renewal, and cancellation observer into `openLeasedExecution`. Features
own their degradation reasons and review's terminal hook cancels a pending
stale-head replacement; the runner knows neither. Its defaults are the production path;
isolated callers instantiate the same cache/context factories without resetting
process-global auth state. Rejected auth lookups evict only their exact pending
entry. Token refresh and credential-identity isolation remain product policy.

## Static guards and generated maps

`nub run lint` and `nub run lint:backend` require zero warnings (`--deny-warnings`). Backend lint denies unsafe type assertions, explicit `any`, and non-null assertions. Narrow from runtime evidence using existing guards and control flow; literal tables check own keys. Typed publication results require a decoder; the erased PR-surface boundary returns `unknown`. `escape()` has one reviewed cast line and zero callers ([ADR 0045](adr/0045-type-narrowing-discipline.md)). The guard ledger also counts `(oxlint|eslint)-disable` markers under `lint-suppressions(src)` (5) and `lint-suppressions(test)` (0). These counts may shrink, not grow.

Both assertion counters force the selected rule on after removing its config overrides. CLI `--deny` alone does not beat a file override. Backend counts are zero; the 546 existing test assertions remain counted no-growth debt while ordinary test lint retains its fixture exemption. Escape calls with type arguments count too.

Machine law lives in scripts plus tests, enforced by `nub run check:guards` (CI `check` job): `scripts/check-guard-ledger.mjs` compares pattern, file, and oxlint counts with the merge base and waits on the `guard-loosening` environment for a growth; `scripts/check-static-baseline.mjs` with `scripts/baselines/static-baseline.json` still checks the stored baseline; `scripts/check-comments.mjs` checks justification markers; `scripts/check-domain-guards.mjs` checks migration numbering and feature-key parity. Syntax rows in `scripts/guards/` are enforced by `test/architectureRules.test.ts`. The single sanctioned cast is `escape()` in `src/util/escape.ts` ([ADR 0038](adr/0038-fail-on-growth-static-baseline.md), [ADR 0039](adr/0039-single-blessed-assertion-escape.md)). Architecture edges are rows in `test/architectureRules.test.ts` with walkers in `test/architectureRulesHelpers.ts` ([ADR 0040](adr/0040-in-repo-import-ruleset.md)). `docs/feature-map.md` is generated by `nub run gen:feature-map` and asserted by `test/featureMap.test.ts` ([ADR 0041](adr/0041-generated-feature-map.md)). Scaffold migrations with `nub run gen:migration <snake_slug>`. Prove the durable path with `nub run verify` (disposable Postgres, artifact under `verify-artifacts/`).

A depth-1 checkout has no `origin/main` history. The ledger fetches that ref and unshallows before it compares counts. Pattern rows are counted in process, one line at a time, because the check runner does not provide ripgrep.

## Tool-round budgets

Every `session.send` that can call tools passes `maxToolRounds`. Investigation turns use their role budget (`MAX_TOOL_ROUNDS`, `MAX_TOOL_ROUNDS_TRIAGE`, and so on), which escalated retries scale. Judgment turns use `ORCHESTRATOR_JUDGMENT_MAX_TOOL_ROUNDS` evidence rounds plus one reserved publish round (at most one extra round); windowed re-reads confirming a line use evidence rounds and never gamble the reserved `publish_thread` slot. A turn whose only job is to call a submit tool is a submit-only turn and uses `SUBMIT_ONLY_MAX_TOOL_ROUNDS` (one submit plus one in-turn correction). Escalation does not scale it. Send it through `runSubmitOnlyRound`, or pass the constant directly as the orchestrator does for recon repair, synthesis, synthesis repair, and summary recovery. A finalize turn that may still do real work, such as triage `commitFix`, is not submit-only and keeps its role budget. The returned turn's `end` is `tool_budget` when the budget stopped the loop.

## Runtime topology diagram

When a change alters **runtime topology**, update the Mermaid diagram in [AGENTS.md](../AGENTS.md) How it works in the same PR. Binding rule: [`.pr-agent/topology-diagram.mdc`](../.pr-agent/topology-diagram.mdc).
