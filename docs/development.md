# Development guide

Module layout, import rules, and the runtime topology diagram rubric for **pr-agent**. Agent index: [AGENTS.md](../AGENTS.md). Maintainer-local Compose is [docker-compose.dev.yml](../docker-compose.dev.yml) (one pr-agent service, Caddy, and a Cloudflare quick tunnel).

Keep root `AGENTS.md` under the byte budget in `scripts/check-agent-context.mjs`
(`npm run check:agent-context`, also run from `npm run check:guards`). The binding
loader drops a root instruction file over 32 KiB. Use pointers to this guide and
the runbooks instead of duplicating their detail.

Binding review rules live in [`.pr-agent/*.mdc`](../.pr-agent/). This guide indexes areas and links those rules. Do not restate `.mdc` bodies here. Author or refresh them with [`skills/authoring-pr-agent-rules`](../skills/authoring-pr-agent-rules/SKILL.md).
Prompt layout, imports, origin, and wording are enforced by `scripts/lint/prompts.mjs` and `scripts/lint/prompt-style.mjs`; `src/prompts/shared/communication.ts` owns output prose style.

## Durable state rules

`node:sqlite` imports live only under `src/state/` and, for the Pi database
handle, `src/agent/runtime/durable/`. `node:sqlite` is synchronous: every
`BEGIN IMMEDIATE ... COMMIT` goes through `immediate(db, fn)` in
`src/state/db.ts` and never contains an `await`. Compute every async input
(GitHub reads, slash authorization, payload parsing) first, then re-validate
inside the transaction. `readRow` and `readRows` parse rows with valibot at the
boundary.

`src/state/workRuns.ts` is the only writer of `work_runs.status`; the guards in
`scripts/guards/` reject `UPDATE work_runs SET status` anywhere else. It claims
a due `pending_dispatch` or `retry_scheduled` row, increments
`current_attempt_no`, inserts the `work_run_attempts` row with a fresh
`attempt_id`, and checks cancellation and the lane epoch. It owns the
`running`, `completed`, `failed`, `cancelled`, `superseded`, and
`retry_scheduled` transitions; retry timing comes from
`src/agentWork/retryPolicy.ts`. Cancelling or superseding returns the Pi
conversation to abort. No remote work runs inside the claim transaction.

`src/state/schema.ts` creates the 15 tables idempotently at open and records
`PRAGMA user_version = 1`. There is no migration framework: a schema change
bumps the version with an explicit, idempotent upgrade in that file, and an
unknown higher version fails startup.

`src/state/publish.ts::publishOnce` owns the fail-closed publish state machine,
the operation-key builders, and scoped completion evidence. Every PR-surface
mutation goes through it. It checks the work run status, the lane epoch, and
the shutdown gate before `reserved → mutating`. It rechecks status and epoch
before reconciling the result and writing `publish_records` under both the
shared and work-run keys. `src/state/recoverIntents.ts` runs the
boot and periodic sweep of `mutating` and `outcome_unknown_recoverable` intents.
The exact transitions are in [topology](topology.md#publishing).

Review recovery accepts a completed summary's `lightweightCompletion: true`
only when that record belongs to the current work run. It repairs the verdict
before fresh admission. An ordinary or foreign summary cannot select this path.

`src/agentWork/ciProjection.ts::requestHeadCiProjection` is the only way to ask
for a CI projection. It sets `pr_head_ci_state.next_projection_at`, inside the
caller's transaction when there is one, and the debounced timer turns a due row
into a `ci_projection` work run.

Runtime-session and send UUIDs are telemetry identity, not prompt-cache identity.
`src/agent/runtime/durable/telemetryBridge.ts` bridges Pi Durable telemetry,
`afterResponse`, and `onReport` into PostHog and evlog.
`src/agent/runtime/sessionTrace.ts` projects session events into one
generation, tool, and compaction event per call, behind an always-present,
nonthrowing observer. `src/analytics/posthogSink.ts` owns the AI capture client.
Credential redaction belongs to `src/traces/content.ts`. Traces never authorize
recovery or publishing; missing generation usage remains absent.
Structured failure origins and lifecycle boundaries outrank wrapper wording.
Typed thread-resolution denial is child-only nonacceptance, and verification
recovery requires exact operation completion receipts rather than resource history.

## New external service

Give a new external service a folder of its own (`src/<service>/`) and a seam of its own, shaped like `PrSurface`. Add one import-rule row so the service SDK loads only there. Read credentials through `src/settings/`. Do not add another `process.env` reader. Land a durable work kind with its executor and publish record in the same PR, and let `docs/feature-map.md` absorb it (`npm run gen:feature-map`). Update the docs pointers in the same PR. The first bad pattern in the new folder becomes a guard row.

## Module layout (production)

`src/index.ts` is the only entry point. It acquires the single-writer lock,
opens `app_state.sqlite` and the Pi harness, runs boot Phase A and Phase B, and
starts the Effect HTTP server. `src/effect/` owns the server, programs,
services, and runtime wiring. `src/effect/server.ts` serves `POST /webhooks`,
`/health`, and `/ready`.

`src/github/installationCapabilities.ts` owns validated available/denied/unknown
operation grants and endpoint permission alternatives.
`src/agentWork/installationSurface.ts` owns fresh bounded repository preflight
and managed token resolution. Token minting requires a single repository,
including on fallback and during intent recovery.
`src/agentWork/githubCapabilityRepository.ts` owns ordered scoped
observations, CI source restoration/revisions, retention,
and preflight counters on `github_repository_capabilities`. No capability
record contains credentials. `runReviewForWorkItem.ts` gates only new work
after exact completion evidence. `reviewVerdict.ts` keeps immutable selected
output and independent applied/skipped-for-this-run/blocked/unresolved surface
applicability. Optional reads and writes are run-scoped, never shared-config
changes.

| Area                                      | Path                                                | Public entry                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Process entry and boot                    | `src/index.ts`, `src/agent/runtime/durable/boot.ts` | Lock, `app_state.sqlite`, harness, Phase A (Pi paused, read-only), Phase B (abort marks, `resume()`, dispatcher, timers, retention, `/webhooks`), and `SIGTERM`/`SIGINT` shutdown                                                                                                                                                                                                                                                                                                                                                                       |
| Durable state                             | `src/state/`                                        | `db.ts` (`openAppState`, `acquireSingleWriterLock`, `immediate`, `readRow`, `readRows`), `schema.ts`, `intake.ts` (one-transaction `runDelivery`), `workRuns.ts` (sole status writer), `publish.ts` (`publishOnce`), `recoverIntents.ts`, `prMutex.ts`, `retention.ts`, plus the quota, CI state, capability, rate-limit circuit, verification ledger, and agent feedback stores                                                                                                                                                                        |
| Durable execution                         | `src/agent/runtime/durable/`                        | `dispatcher.ts` (claim loop, per-kind concurrency, PR mutex), `reviewOrchestratorTask.ts`, `featureAttemptTask.ts`, `featureExecutors.ts` (`createFeatureExecutors`, `createAckHandler`), `workerDeps.ts` (`WorkerDeps`), `harness.ts` (`openDurableHarness`), `runtime.ts`, `durableReset.ts` (zero-503 `pi_durable.sqlite` reset), `session.ts`, `piTools.ts` (`read_pinned`, `read_spill`, `read_triage`, Code Mode), `evidenceMemo.ts`, `telemetryBridge.ts`, `providerRouting.ts`                                                                  |
| Review run + publish                      | `src/review/`                                       | `runReviewForWorkItem.ts` (feature entry), `orchestrator/orchestratorRun.ts` (phase functions; `orchestrator/runStep.ts::nextSynthesisStep` picks the synthesis step), `publish/reviewPublishSession.ts`, `publish/publishSummaryOnly.ts`, `publish/publishFindingBatch.ts`, `ci/ciFacts.ts` (snapshot types, rollup, facts-only summary, authored cache), `ci/ciAuthor.ts` (log intake and condensing, LLM CI author called from the projector), `ci/ciSummaryCell.ts` (cell render, CI and verification markers); metrics/footer helpers under `run/` |
| Local PR workspace                        | `src/prWorkspace/`                                  | `prRepositoryView.ts` (`withPrRepositoryView`); `localPrWorkspace.ts` owns pinned preparation and cleanup; `repositoryReader.ts` owns pinned/writable readers and Git errors; `gitProcess.ts` owns process-group Git spawning and termination; `checkoutTelemetry.ts` owns checkout fetch attempts and their analytics fields; `fff/` owns the fff search host and pinned search; `workspaceResource.ts` owns allocation, heartbeat, credentials and release                                                                                            |
| Webhook intake                            | `src/webhook/`, `src/state/intake.ts`               | `src/webhook/intakeCommand.ts` owns pure event mapping; `src/state/intake.ts` owns dedupe, lifecycle, slash and `/ask` admission, approval gating, and `work_runs` insertion in one `BEGIN IMMEDIATE`                                                                                                                                                                                                                                                                                                                                                   |
| Feature executors                         | `src/agentWork/executors/`                          | One executor per kind; executors return closed completion values and publish only through `src/state/publish.ts`. `src/agentWork/` keeps pure domain helpers (`retryPolicy.ts`, `reviewVerdict.ts`, payload schemas, operation-key inputs, verification ledgers) beside them                                                                                                                                                                                                                                                                            |
| Ask / description / verification / triage | `src/agent/`                                        | `ask/askRun.ts`, `description/descriptionRun.ts`, `verification/verificationRun.ts`, `triage/`                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Pi session seam                           | `src/agent/runtime/`                                | `createFeaturePiSession` (`createFeatureSession.ts`) resolves model and lifecycle policy and accepts an injected session adapter; `featureAgent.ts` shares submit/repair ordering for description, verification, and triage; `rateLimitCircuit.ts` (`openRunRateLimitCircuit`) opens the per-run GitHub circuit for review and ask. `@earendil-works/*` value imports stay under `src/agent/runtime/durable/`                                                                                                                                           |
| PR surface seam                           | `src/github/`                                       | `prSurface.ts` (`createPrSurface`, `createFakePrSurface`); `mutationOctokit.ts` is the mutation-only client (no retry or throttling, 20 s timeout); `recoverPrSurfaceMutation.ts` owns exact-evidence recovery and open-PR rediscovery. Feature code must not import `prSurfaceImpl.ts` or thread installation tokens                                                                                                                                                                                                                                   |
| Installation execution surface            | `src/agentWork/installationSurface.ts`              | `openInstallationSurface` owns App/private-key/installation-scoped auth caches and surface creation for work runs; injected production and fake adapters share that policy                                                                                                                                                                                                                                                                                                                                                                              |
| Agent tool outputs                        | `src/agent/tools/`                                  | `toolOutputBudget.ts`, `pathPolicy.ts` (`createPathPolicy`, `isTriageSearchPathAllowed`); review sessions fence results with `wrapUntrustedEvidence` in `src/review/run/reviewRunSetup.ts`                                                                                                                                                                                                                                                                                                                                                              |
| Outbound security                         | `src/security/`                                     | `redactOutboundSecrets.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Analytics facade                          | `src/analytics/`                                    | `index.ts` (`initAnalytics`, `captureEvent`, `captureException`, `shutdownAnalytics`); `workCompleted.ts` (`recordWorkCompleted`, called after the terminal `work_runs` write commits; `webhook received`, `ci state changed`); `workSpan.ts` (`$ai_generation` / `$ai_span`)                                                                                                                                                                                                                                                                           |

Review, ask, description, and verification take the prepared Local PR workspace object. Verification derives the session working directory from `workspace.agentCwd` and uses `workspace.reader` for bounded reads, literal search and cached PR-patch diffs. It does not keep a second string checkout path.

Executors receive `WorkerDeps` (`db`, `runtime`, `cfg`, `installationSurface`,
optional `createSession`, `shutdownRequested`, optional `now`). They acquire
read-only views after the dispatcher has charged the attempt. Publication
checks the abort signal, durable cancellation, and the lane epoch, in that
order, through `publishOnce`. Review adds its live-head predicate; triage keeps
its separate writable checkout and closed-PR commit/push guards.

`Config` is nested slices (`runtime`, `github`, `webhook`, `associations`, `features`, `models`, `provider`, `agentEvents`, `codeMode`, `review`, `concurrency`, `ask`, `queue`, `retention`, `posthog`, `logging`). The slices also carry `SQLITE_DIR`, the optional `SQLITE_DB_PATH` inside that directory, `SHUTDOWN_GRACE_MS`, and the `pi_durable.sqlite` reset caps; there is no role setting. Each slice reader lives in `src/settings/slices/` and uses the typed readers in `src/settings/envReaders.ts`, the only `NODE_ENV` read. `src/settings/config.ts` composes them and its `loadConfig` stays the single entry; the settings barrel exports it. A module takes the slice it needs (`Config["ask"]`, `Pick<Config, "features">`). Tests build slices with `makeTestConfig`.

Public entries and placement-import rules: [`.pr-agent/module-layout.mdc`](../.pr-agent/module-layout.mdc). Native `.ts` imports and settings barrel: [`.pr-agent/esm-imports.mdc`](../.pr-agent/esm-imports.mdc).

Within intake, `src/state/intake.ts` resolves the slash winner and the ID-pinned
triage payload, applies provider-ordered lifecycle state, and makes automated,
slash, approval, and lifecycle decisions final in the same transaction.
`reviewReschedule.ts` reads lifecycle in its own `immediate()` before creating a
stale-head replacement; closed/merged refusal precedes progress ownership
transfer. A replacement payload merges atomically on an identifier conflict:
stored child values win over replayed parent values, and missing incoming
fields are added. `/ask` admission (`src/state/askQuotas.ts`) owns same-mention
agreement, quota reservation, and matching work insertion as one part of the
delivery transaction. It reads the triggering comment identity and any retained
ask run in any status before checking quota.

Pinned checkouts search through `src/prWorkspace/fff/workspaceSearch.ts`. It asks the fff host (`src/prWorkspace/fff/host.ts`, a forked child process and the only importer of `@ff-labs/fff-node`) for the paths fff indexes, sends every other allowed tracked path to `git grep`, and falls back to `git grep` for the whole call when the host fails. `gitGrepWorkspace` in `src/prWorkspace/repositoryReader.ts` runs literal `git grep -nF -I -z` and applies result and stdout-byte limits after parse. Writable triage checkouts use it alone. Debian bookworm Git 2.39.x in the application image is enough; the helper does not pass `--max-count`.

Pinned search retains at most 200 returned matches, including ranked output and
fallback. The host supplies validated byte offsets, not truncated native
snippets. The reader merges candidates before seeking to selected complete
lines, reuses a 64 KiB chunk, and enforces the byte budget during materialization.
Writable triage keeps its existing raw-match collection before path filtering;
the shared Git helper and general `maxResultsParam` are not globally capped.

`RepositoryReader` has two production adapters: the pinned PR view and the
writable triage checkout. `PathPolicy` retains review/ask's changed-sensitive-path
gate, verification's sensitive-path refusal, and triage's sensitive/control-path
checks. Investigation, verification, and triage reads all use realpath
containment. Tool profiles retain their distinct ordered
descriptions, schemas, wire output, spill cleanup and delivered-read evidence.
Commit attribution lives in `src/agent/triage/commitAttribution.ts`; checkout
identity validation and final commit/push guards remain at the mutation boundary.
Resource owner markers and the live-root registry are private; allocation and
sweeping are the production interface and the existing owner tests exercise them.

`createReviewSummaryComment` in `reviewSummaryComment.ts` is the only writer of
the review summary comment: progress ticks, the terminal summary, cancelled and
failure notices, and the lightweight completion. It serializes revisioned
upserts per resource and lens under the in-process PR mutex, from the fresh
remote read through the result record. `run/commentMarkers.ts` owns the
progress-revision marker codec. Terminal writes use revision 7, so a late tick
cannot replace a summary or notice. CI projection and direct edits do not take
this path.

Terminal GitHub reviews share the PR mutex. Verification holds it from fresh
finding inventory through verdict publication; full-review terminal
publication takes it after the summary and verdict writes. Bounded
terminal-review waits are best-effort skips.
`src/review/findingIdentity/threadMutationLock.ts` adapts the mutex for review
duplicate cleanup, triage, and verification.

`src/agentWork/reviewVerdict.ts::reviewVerdict` returns `{pending, close, repairIfOpen}`.
It resolves summary details links and applies only the first selected verdict,
which `publishOnce` keeps in `pr_state.selected_verdict_json`.
Check and commit-status acceptance retain separate receipts and fail-closed repair.
A terminal unknown check close is not selected or sent again.
Explicit null comment IDs retain no-link output on acknowledgement, stale-head,
and projector paths; just-written comments can supply their IDs before
a durable record exists.

Sessions run on Pi Durable 1.6.0. `src/agent/runtime/durable/session.ts`
adapts the `PiSession` interface in `src/agent/runtime/types.ts` onto durable
conversations; `piTools.ts` registers `read_pinned` (replay-safe, pinned
checkout), `read_spill`, and `read_triage` with path policy on the resolved
realpath, plus Code Mode from `@earendil-works/pi-durable/codemode` with
`timeout_ms` and `max_output_tokens` clamped before the deadline is journaled.
`evidenceMemo.ts` credits complete tool-result lines after a provider response.
`reviewTurnJournal.ts` stores the submitted turn's budget, reads, visible
ranges and accepted tool outputs so a fresh process can rebind the same child
before scheduling starts. `session.ts` owns each send's inactivity watchdog and abortable
waits; idle-deadline, cancellation, and tool-budget stops stay distinct from
provider outages.

## Landing site

The marketing site (`site/`, package `pr-agent-landing`) is a separate workspace package. It is not required to run the bot. Its visual system, tokens, and component recipes are documented in [`site/DESIGN.md`](../site/DESIGN.md); read it before changing the page's look. [`site/AGENTS.md`](../site/AGENTS.md) holds the agent rules for changing that system: token layers, recipe owners, DESIGN.md format, and verification. Before markup, a style, or client-side interaction under `site/`, follow the guidance CLI rule in that file's Before UI work section. `npm run check:site-design` (CI `site` job) runs `scripts/check-site-design.mjs` against `scripts/baselines/site-design-baseline.json`: undeclared colour tokens, raw colours, primitive reads, off-scale type sizes, arbitrary values, unguarded hovers, `transition: all`, card, chip, and section-title clones, and `@theme` tokens missing from DESIGN.md. Counts only shrink; the rule table lives in [DESIGN.md](../site/DESIGN.md#verification).

Agent-facing copy lives in [`site/lib/llmsKnowledge.ts`](../site/lib/llmsKnowledge.ts). Update it and regenerate `site/public/llms.txt` alongside relevant README and docs changes without separate copy approval. The dev server rewrites that file when a watched knowledge module changes. The production build compares the committed file with `renderLlmsTxt()` and fails without rewriting it. The human page stays a short overview, but its App event list, permissions, and command tips must match [README.md](../README.md) and that profile. AI agents must propose the exact wording of any human-page correction and wait for explicit user approval, preserving its tone and wording otherwise. Shared constants are not an exemption from that gate. See [Public documentation](public-voice.md#public-documentation) and [site/DESIGN.md](../site/DESIGN.md#content-and-voice). Agents read `/llms.txt`, `GET /llms?query=`, and `GET /llms/json?query=`.

Every agent-facing URL is declared once in [`site/lib/agentResources.ts`](../site/lib/agentResources.ts), which renders llms.txt link lists, `robots.txt` pointers, `sitemap.xml`, `/openapi.json`, the 404 body and page, the `Link` headers, and the head's `alternate`/`describedby` links. Add an endpoint there, not in each surface; surfaces that point at one resource by identity use its named registry entry.

Discovery documents are rendered by [`site/lib/agentDiscovery.ts`](../site/lib/agentDiscovery.ts). `robots.txt` and `sitemap.xml` build absolute URLs from the request origin when that host is the build origin, localhost, or a `vercel.app` host. Any other host falls back to the build origin. Sitemap locations are XML-escaped, and those responses vary on `Host`. The AI catalog uses one host form for `did:web` and `urn:air`, including an encoded port. Canonical and OpenAPI stay on the build origin. `robots.txt` carries `Content-Signal: ai-train=no, search=yes, ai-input=yes` and an `Agentmap` to `/.well-known/ai-catalog.json`. `/.well-known/api-catalog` is the RFC 9727 linkset for the site's own OpenAPI document. `POST /mcp` is a read-only MCP server (profile query and resource list, no token) with its card at `/.well-known/mcp/server-card.json`. `/.well-known/agent-skills/index.json` lists `read-pr-agent` and the sha256 of that `SKILL.md`. The landing page registers the same query tools, plus `open_section`, through the WebMCP API. `/auth.md` says these endpoints are public. This origin is not an authorization server, so it does not publish OAuth or protected-resource metadata. `GET /health` on this site is landing-site liveness only. A deployment's `/health` and `/ready` stay on the operator's host.

DNS for AI Discovery is not in this repository. The operator's DNS host publishes ServiceMode HTTPS records and signs the zone with DNSSEC:

```
_index._agents.example.com. 3600 IN HTTPS 1 example.com. alpn="h2" port=443
_mcp._agents.example.com. 3600 IN HTTPS 1 example.com. alpn="h2" port=443 mandatory=alpn,port
```

Replace `example.com` with the site's domain. The target is this site. `alpn` is `h2` because the site speaks HTTPS, not an A2A agent protocol.

`/` negotiates on `Accept`. HTML is the default, `text/markdown` is served when asked, and 406 answers a header that accepts neither. The parser is [`site/lib/accept.ts`](../site/lib/accept.ts). Its sibling [`site/lib/acceptLanguage.ts`](../site/lib/acceptLanguage.ts) reads `Accept-Language` for a programming language and picks the fetch example on the markdown page. Locale tags such as `en` and `en-US` are ignored, and only full words count, so `ts`, `js`, `py`, and `sh` are read as locale tags. `golang` and `shell` are aliases. The served set is `typescript` (default), `javascript`, `python`, `go`, `java`, `ruby`, and `bash`, derived from the variant snippet in [`site/lib/content.ts`](../site/lib/content.ts). Markdown `/` varies on `Accept` and `Accept-Language`, `/index.md` varies on `Accept-Language`, and HTML `/` and the 404 vary on `Accept` only. Responses and the 404 recovery document are [`site/lib/siteHttp.ts`](../site/lib/siteHttp.ts). The request middleware that applies them is [`site/start.ts`](../site/start.ts). Every HTML section renders from the same constants as the markdown in [`site/lib/pageMarkdown.ts`](../site/lib/pageMarkdown.ts). The markdown representation also carries the agent fetch example and its language-variant fences. `/` is not prerendered. The server function must see every request for negotiation to work.

## Internal errors (`AppError`)

Production failures in `src/` use `AppError` from `src/errors/appError.ts`, constructed with a closed `{domain, kind}` pair declared in `src/errors/appErrorCodes.ts`. Field rules, helpers, domain subclasses, and the AppError-never-on-PR rule: [`.pr-agent/structured-errors.mdc`](../.pr-agent/structured-errors.mdc). `serializeAppError` and `errorLogFields` are the canonical sanitized representation for telemetry; evlog, analytics, PostHog, and startup logging sanitize Error values and metadata again at their boundaries, so callers do not need to pre-sanitize contexts or causes.

## Prompt prose

Long investigator prompt blocks stay in prompt modules. Shared sections live in `src/prompts/shared/`: `prefix.ts` owns the byte-identical specialist instruction prefix, `safety.ts` owns trust framing and envelopes, `context.ts` renders shared runtime context, `communication.ts` owns prose style, `behavior.ts` owns shared review discipline, `output.ts` owns response contracts, `tools.ts` owns shared Code Mode harness guidance, and `repair.ts` owns the repair text used by all four specialists. Role prompts, user-message builders, run turns, and role-specific repair text live in `src/prompts/<role>/prompt.ts`, alongside harness and native-tool exports. Orchestrator turns, brief rendering, and trusted-context assembly live in `src/prompts/orchestrator/prompt.ts`, with its formatters in `context.ts`. Fetching stays in `src/review/run/reviewTrustedContext.ts`; path and size builders and accepted-finding slimming stay in review feature code. Correctness uses `src/prompts/correctness/prompt.ts`. Security, quality, and tests personas live in `src/prompts/{security,quality,tests}/prompt.ts`, and `src/prompts/shared/communication.ts` owns the shared reader-first and STE100 writing guidance for review, triage, ask, verification, description, and the CI author. Only numeric limits and shared user-visible strings belong in `src/settings/*Constants.ts`. Binding rule: [`.pr-agent/prompt-vs-constants.mdc`](../.pr-agent/prompt-vs-constants.mdc). The correctness persona prompt includes an ordered risk-directed investigation method; its high-signal bug-pattern list remains supporting recognition. Code Mode roles also include a generated guest-capability catalogue from `src/agent/codemode/guestCatalogue.ts` in the stable prefix. That list is the installed `tools.*` set for that role, not the bug-pattern list. Description and triage keep native workspace tools and do not receive `execute`. CI summary and bound-policy judgment are no-tool JSON turns. Inspect a persona's generated prompt with `npm run dump-prompt -- <persona>` (`scripts/dump-prompt.ts`); prompt changes are proven by inspected prompt output, not `check:code` alone. Model-facing tool schemas go through `toToolParameters` in `src/agent/tools/toolParams.ts`, which closes objects for the model and owns the shared parameter descriptions. Adaptive-thinking prompts state goals and done-criteria with no unenforced caps and one copy of each contract (`scripts/lint/prompt-style.mjs`). Reader-facing banned patterns and length targets live in `src/prompts/shared/communication.ts`. Prompt module layout under `src/prompts/`, its section names, and the `pr-agent/prompt-layout`, `pr-agent/prompt-imports`, and `pr-agent/prompt-sinks` lint rules live in `scripts/lint/prompts.mjs`.

`npm run dump-prompt -- all` emits deterministic JSON for every role's system prompt
and ordered tool definitions, including native workspace definitions hidden by
Code Mode. It constructs definitions without running
tools, creating sessions, or contacting providers. Compare its complete output
before and after a refactor; an empty diff protects the stable prompt-cache
prefixes, not provider cache hit rates. The four specialist prompts start with
`specialistSharedPrefix` (`src/prompts/shared/prefix.ts`). An empty dump diff is
the check for a structure-only move only.

Concrete modules own the M1 interfaces. Workspace callers import
`prRepositoryView.ts`, `localPrWorkspace.ts`, or `writablePrCheckout.ts` directly.
`PrResource`, `PrRef`, and `ReplyTarget` live in `src/agentWork/types.ts`.
`PrSurface` requires bot-login, review-list, and review-check reads;
implementations cannot omit those recovery capabilities. It exposes raw GitHub
reads (`getHead`, `listReviewComments`, `listPullRequestReviews`) and one
`updatePullRequest` write; prior-feedback thread assembly lives in
`reviewPriorFeedback.ts` and description merging in
`src/agent/description/descriptionPublishPlan.ts`.
Review status phrases live in `src/review/statusCopy.ts`, CI action phrases in
`src/review/ci/ciSummaryCell.ts`, and specialist prompt selection in
`src/review/orchestrator/specialistRun.ts`. Helpers with one owner stay private
there; existing tests exercise their observable publication or execution output.

The dispatcher takes `handlers: { review, feature, ack }`. Features own their
degradation reasons, and review's terminal handler cancels a pending stale-head
replacement; the dispatcher knows neither. Its defaults are the production
path; isolated callers instantiate the same cache/context factories without
resetting process-global auth state. Rejected auth lookups evict only their
exact pending entry. Token refresh and credential-identity isolation remain
product policy.

## Static guards and generated maps

`npm run lint` and `npm run lint:backend` require zero warnings (`--deny-warnings`). Backend lint denies explicit `any` and non-null assertions. Narrow from runtime evidence using existing guards and control flow; literal tables check own keys. Typed publication results require a decoder; the erased PR-surface boundary returns `unknown`. `escape()` has one reviewed cast line and zero callers. The guard ledger also counts `(oxlint|eslint)-disable` markers under `lint-suppressions(src)` (4) and `lint-suppressions(test)` (0). These counts may shrink, not grow.

The explicit-any and non-null counters force the selected rule on after removing its config overrides. CLI `--deny` alone does not beat a file override. Escape calls with type arguments count too.

Machine law lives in scripts plus tests, enforced by `npm run check:guards` (CI `check` job): `scripts/check-guard-ledger.mjs` compares pattern, file, and oxlint counts with the merge base and waits on the `guard-loosening` environment for a growth; `scripts/check-static-baseline.mjs` with `scripts/baselines/static-baseline.json` still checks the stored baseline; both counters build their oxlint config through `scripts/forcedOxlintConfig.mjs`; `scripts/check-domain-guards.mjs` checks feature-key parity, banned packages, and disabled Landmines rules. `scripts/check-agent-context.mjs` checks agent context budgets, the single topology diagram, `.pr-agent/*.mdc` caps and repo-path anchors, and that disclosed pointers resolve. Syntax rows in `scripts/guards/` are enforced by `test/architectureRules.test.ts`. Linted source carries no comments: `pr-agent/no-comments` in `scripts/lint/no-comments.mjs` reports and fixes them, keeping only `oxlint-disable-next-line <rule> -- <reason>` and `/// <reference />` directives. The same lint step loads `@interfere/landmines` and errors on the seven adopted rules in `.oxlintrc.json`. `no-test-doubles`, `colocated-tests`, and `test-file-names` stay off because they contradict the Pi session seam, `PrSurface`, the root `test/` layout, or the tests reviewer directory. The single sanctioned cast is `escape()` in `src/util/escape.ts`. Architecture edges are rows in `test/architectureRules.test.ts` with walkers in `test/architectureRulesHelpers.ts`. `docs/feature-map.md` is generated by `npm run gen:feature-map` and asserted by `test/featureMap.test.ts`. `src/state/schema.ts` owns the `app_state.sqlite` schema and its `user_version`. Prove the durable path with `npm run verify` (disposable `SQLITE_DIR`, PRAGMA read-backs, artifact under `verify-artifacts/`).

A depth-1 checkout has no `origin/main` history. The ledger fetches that ref and unshallows before it compares counts. Pattern rows are counted in process, one line at a time, because the check runner does not provide ripgrep.

## Tool-round budgets

Every `session.send` that can call tools passes `maxToolRounds`. Investigation turns use their role budget (`RECON_MAX_TOOL_ROUNDS`, `SPECIALIST_MAX_TOOL_ROUNDS` (the wrap-up steer fires at `REVIEW_SPECIALIST_WRAP_UP_TOOL_ROUNDS`), `MAX_TOOL_ROUNDS_TRIAGE`, and so on), which escalated retries scale. Judgment turns use `ORCHESTRATOR_JUDGMENT_MAX_TOOL_ROUNDS` evidence rounds plus one reserved publish round (at most one extra round); windowed re-reads confirming a line use evidence rounds and never gamble the reserved `publish_thread` slot. A turn whose only job is to call a submit tool is a submit-only turn and uses `SUBMIT_ONLY_MAX_TOOL_ROUNDS` (one submit plus one in-turn correction). Escalation does not scale it. Send it through `runSubmitOnlyRound`, or pass the constant directly as the orchestrator does for recon repair, synthesis, synthesis repair, and summary recovery. A finalize turn that may still do real work, such as triage `commitFix`, is not submit-only and keeps its role budget. The returned turn's `end` is `tool_budget` when the budget stopped the loop.

## Runtime topology diagram

When a change alters runtime topology, update the Mermaid diagram in [docs/topology.md](topology.md) in the same PR. Binding rule: [`.pr-agent/topology-diagram.mdc`](../.pr-agent/topology-diagram.mdc).
