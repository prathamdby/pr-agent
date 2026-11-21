# Operations and behaviour

Behaviour semantics, deployment detail, and developer scripts for **pr-agent**. For env tunables see [configuration.md](configuration.md). For work run SQL, recovery, retention, and the `pi_durable.sqlite` reset see [agent-work-ops.md](agent-work-ops.md). Domain terms: [CONTEXT.md](../CONTEXT.md).

## What the service does

Concurrent attempts to finish a review keep the first verdict. A later cancellation or recovery does not replace it. If the check finishes before its enabled status, repair completes only that status from the saved verdict. Ambiguous publication stays fail-closed; this is not an exactly-once HTTP guarantee. The selection lives in `pr_state.selected_verdict_json`. Inspection: [agent-work-ops.md](agent-work-ops.md#own-verdict-recovery).

- On **`pull_request`** (`opened`, `synchronize`, `reopened`), durable intake runs. On **`opened`**, `auto` reviews immediately and `approval` reviews trusted authors immediately, while untrusted forks receive one awaiting approval row and NOTE comment without an eyes reaction. Trust means a same-repo head or an `OWNER`, `MEMBER`, or `COLLABORATOR` author. A fork author associated as `CONTRIBUTOR`, `NONE`, `FIRST_TIME_CONTRIBUTOR`, or `FIRST_TIMER` waits for a pull request approval or `/review`. Missing association or deleted fork is untrusted. `FEATURE_DESCRIBE=auto` still enqueues a **description run** on open. On **`synchronize`**, awaiting heads move in the intake transaction, active auto reviews in `auto` or `approval` are cancelled and replaced with one deferred-head review, and `FEATURE_VERIFICATION=auto` enqueues verification. An authorized maintainer reply on an inline review thread also enqueues verification when `FEATURE_VERIFICATION=auto`, and does not cancel a queued or running verification item. With the default `FEATURE_REVIEW_CADENCE=once`, finished reviews are not restarted by a push. `every_push` starts a review for each later push to an open admitted pull request, and leaves a running `/review` in place for one follow-up. A retry after that follow-up is enqueued keeps the child's stored head. Turning it off is `FEATURE_REVIEW_CADENCE=once`. **`reopened`** restores lifecycle admission without starting automatic work or recreating awaiting approval. Close/merge withdraws awaiting approval and replaces its notice with the existing cancellation notice. Review acknowledgement posts 👀 and a queued progress stub; review execution adds Recon and the four specialists, then replaces the stub with the final **`## PR Agent Review`** summary. Terminal success replaces 👀 with 👍; terminal failure replaces it with 👎. Description runs merge their marked block into the PR body and preserve your text outside it.
- On **`issue_comment`** and **`pull_request_review_comment`** (`created` only), detects `/help`, `/ask`, `/describe`, `/review`, `/cancel`, `/triage`, and `/verify`. It also promotes allowed `@bot` mentions to ask intake. A reply that is not a slash command and does not mention the bot enqueues verification when the author is an authorized maintainer, `FEATURE_VERIFICATION=auto`, and the comment is on an inline review thread. `manual` and `off` ignore that reply.
- With **`FEATURE_REVIEW=approval`**, a **`workflow_run`** `in_progress` with `event=pull_request` on the awaiting head consumes the row once, except a fork author associated as `CONTRIBUTOR`, `NONE`, `FIRST_TIME_CONTRIBUTOR`, or `FIRST_TIMER`, whose workflow start does not admit the row. A submitted approving **`pull_request_review`** from a non-bot in `SLASH_ALLOWED_ASSOCIATIONS`, or an admitted `/review`, also consumes the awaiting row once. Without an awaiting row every approval signal is ignored, including after completion. Completed, `push`, and `pull_request_target` workflow runs never approve reviews; completed runs keep the CI projection path. Already-open PRs are not backfilled; use `/review`. Work runs publish all **PR-surface I/O** after durable intake. Approval is the default, so trusted opens now spend tokens; `manual` opts out. `auto` reviews every open and does not check trust.
- Responds **`200`** after **durable intake** commits to `app_state.sqlite` (or **`503`** if intake cannot commit; GitHub may redeliver). New work lands as `work_runs` rows in `pending_dispatch`. Reactions, progress comments, reviews, and ask answers run from the dispatcher in the same process and may appear seconds after the HTTP response. The webhook does not wait for LLM runs to finish.

CI facts and the debounced projection time (`pr_head_ci_state.next_projection_at`)
commit in the intake transaction. If that write fails, intake rolls back and
returns `503` instead of accepting a delivery it cannot project. Rendering
still reads durable head state.

Repeated `/review`, `/describe`, `/triage`, and `/verify` commands are acknowledged
without duplicate active slash work. Their insert resolves its winner atomically
and holds that row through intake commit; triage reads that winner's payload by ID.
A cancellation racing resolution no longer causes a missing-winner intake failure.
A cancellation or completion that finishes first can allow a fresh run.
`/verify`'s earlier active-work precheck can acknowledge work that finishes
before the reply posts. Real storage failures, including an exhausted SQLite
`busy_timeout`, still roll back and return `503`.

## Behaviour and semantics

- **Boot reconciliation:** boot Phase A runs before any agent work resumes. It
  reconciles `mutating` publish intents, sweeps `outcome_unknown_recoverable`
  ones, projects terminal task outcomes, adopts orphan tasks by
  `(workId, attemptNo)`, and collects cancelled or superseded tasks to abort.
  Phase B resumes the harness, aborts those, and only then opens `/webhooks`.
  See [topology](topology.md#boot-shutdown-and-reset).
- **Work retries:** each dispatcher claim of a due work run inserts one
  `work_run_attempts` row; the total stays `QUEUE_RETRY_LIMIT + 1`. An attempt
  interrupted before the provider still counts. Boot adoption, projection, and
  recovery-only completion are free. A failed attempt returns as
  `retry_scheduled` with `next_retry_at` backoff from
  `QUEUE_RETRY_DELAY_SECONDS` up to `QUEUE_RETRY_DELAY_MAX_SECONDS`.
  `work item retried` covers those charged attempts. See
  [the work run runbook](agent-work-ops.md).
- **Progress ownership conflicts:** a replacement review keeps ownership of the progress comment. Late specialist ticks from the earlier run are skipped or rejected with an ownership warning. See [work run health](agent-work-ops.md#inspect-work-run-health).
- **Progress ordering:** late older ticks from the same review do not replace newer progress or its final summary. Revisioned upserts serialize the fresh read, GitHub write, and result record; CI projection and direct comment edits remain separate.
- **Payload boundary:** each subscribed `X-GitHub-Event` type is validated with minimal Valibot shapes before deduplication. Malformed payloads are logged and skipped without inserting durable dedupe rows (so GitHub retries can succeed after fixes or transient issues).
- **Slash commands** are detected on the **first non-empty line** only, and are **case-sensitive** (`/review` works; `/Review` does not). `/ask <question>` answers one question about the PR or a specific diff line (**code anchor**).
- **Webhook deduplication** is durable: `webhook_deliveries.delivery_key` keeps delivery-ID correlation (falling back to the body hash when GitHub sends no delivery ID), while `webhook_body_replays.body_hash` blocks the same verified body under any delivery ID; a cross-delivery replay deletes the new delivery reservation. Both use `WEBHOOK_EVENTS_RETENTION_SECONDS` (30 days by default). Duplicate deliveries return **`200`** without creating duplicate **work runs**. Verified, parsed ignored events consume the same replay window; malformed payloads do not.
- **Duplicate evidence:** every committed rejected arrival inserts its own metadata-only `webhook_rejections` row, with its incoming delivery ID, body fingerprint, and guard reason. It adds no work. Audit-write failure rolls back intake and returns `503`. Evidence expires by its own arrival age under the same 30-day webhook setting, independently of accepted events, and does not extend replay protection. `RETENTION_ENABLED=false` leaves this evidence unpurged. ID/body patterns alone do not establish malicious intent. Inspection and rollout: [agent-work-ops.md](agent-work-ops.md#duplicate-delivery-evidence).
- **Review superseding:** when a newer automated review is admitted for the same PR, it supersedes pending auto-reviews and requests cancellation of an in-flight auto-review. A `synchronize` push does the same from intake: it supersedes pending auto-reviews, marks the running one cancelled, and inserts one deferred-head replacement, all in the intake transaction. With `FEATURE_REVIEW_CADENCE=once`, no replacement is created when no review is active, so a push does not re-review a finished PR. `every_push` inserts that replacement for each later push to an open admitted pull request. A slash review is not cancelled. A follow-up still in `pending_dispatch` stays pending so its claim reads the newest head. A follow-up that is already running receives a cancellation request and is replaced. The dispatcher aborts the cancelled run's Pi conversation, which cascades to its specialists; the running review also observes the cancellation (`REVIEW_CANCEL_POLL_INTERVAL_MS` after an immediate first tick) and every `reviewOrchestratorTask` phase entry rechecks it. Automated **verification** on `synchronize` uses the same supersede pattern for prior verification runs. Slash-command reviews are not superseded.
- **Review check-run identity:** review binds `PR Agent Review` to the exact repository, head SHA, check name, and requesting work run external ID. It adopts a remote run only after a proven duplicate-creation error and one exact provider match; ambiguous or incomplete provider state remains unresolved.
- **Own verdict:** one writer (`reviewVerdict(...).close`) finishes `PR Agent Review` and, when `FEATURE_COMMIT_STATUS` is on, `pr-agent/review`. Publish maps the finding lifecycle view to check `failure` (any open finding at or above `REVIEW_CHECK_FAIL_SEVERITY`, carried or new, including an open same-id copy this run did not resolve; default `P2`, so `P3` fails only when the threshold is `P3`), `neutral` with status `error` (earlier findings could not be loaded and none is known to block), or `success`, with the matching commit status. After the summary, one extra GitHub review uses that same close outcome (`REQUEST_CHANGES`, `APPROVE`, or `COMMENT`). Incremental thread batches stay `COMMENT`. A terminal `COMMENT` dismisses this app's standing `CHANGES_REQUESTED` and `APPROVED` reviews so Files changed shows this run. App approvals with Contents: read often do not count as required reviews; the check stays the merge gate. A self-authored PR that 422s `APPROVE` or `REQUEST_CHANGES` falls back once to `COMMENT`. After the summary has settled, remaining createReview or dismiss errors log and do not fail the check. The docs-only lightweight path and failure notices list the open findings carried from earlier reviews. Partial coverage is check `neutral` and status `error` unless an open finding is already at or above `REVIEW_CHECK_FAIL_SEVERITY`, in which case it is published failure, status `failure`, and GitHub review `REQUEST_CHANGES`. Cancel, supersede, and stale head are check `cancelled` and status `error`. Crash and unpublished are check `action_required` and status `error`. Accessible statuses can start `pending` independently of Checks. A review attempt that cannot finish is retried or failed by the dispatcher, and a failed review closes applicable verdict surfaces as crashed. Crash and CI repair (`reviewVerdict(...).repairIfOpen`) finish the check and optional commit status only. They do not submit the extra GitHub review, so Files changed does not gain `REQUEST_CHANGES` or `APPROVE` after a recovered check. The extra review is publish-path and best-effort. Projection repair separately retries unresolved applicable check and status surfaces for terminal reviews; never-started skipped surfaces do not keep repair open.
- **Stale-head reschedule.** Automatic-review preflight and the publish gate detect a moved PR head. The review cancels the stale auto or slash run and inserts one replacement review for the latest head. The replacement takes ownership of the existing **review progress comment**, so its acknowledgement refreshes the stub and later specialist ticks and summary update the same comment. Retrying a stale review keeps changes already saved on its replacement. Stored payload values win collisions; incoming-only fields are added. A replacement that also goes stale fails with retry guidance instead of looping.
- **Verification review verdict:** after settling thread actions or skipping an already-resolved inventory, verification reloads finding state and replaces only a disagreeing standing app verdict: complete inventory with zero blockers approves, and a known open blocker requests changes. An open same-id copy at or above the check threshold is a blocker even when the oldest thread for that id is resolved or below the threshold. No standing verdict, matching verdict, or incomplete evidence without a blocker stays silent. An incomplete thread read records `thread_resolution_degraded` and does not approve; a known blocker in that inventory may still request changes. Compare truncation, a narrowed inventory, objection truncation, and an objection cap still approve when that fresh inventory is complete and every owned review thread is resolved. Any other degradation reason stays silent for approval and skips a request-changes transition. The verdict sees the full reason list, including an incomplete thread read. Queued/running full reviews take precedence. Fresh inventory reads and terminal reviews share the PR mutex; a bounded wait timeout skips publication without failing either run. Live-head and cancellation gates run before refresh and again before publication; verification operation keys and markers bind the work run, head SHA, and event for retry recovery. Full-review operation keys are unchanged. Errors log `verification_review_verdict_failed` without failing the run; incomplete inventory, active reviews, degradation, and lock timeouts log `verification_review_verdict_skipped`. This does not refresh checks or commit statuses.
- **Orchestrated reviews:** acknowledgement posts a queued progress stub (Head/Source, optional Queue `#N of M` wait rank among queued reviews for the same pull request, optional CI) before the dispatcher claims the review. The review orchestrator then performs reconnaissance and writes one specialist brief. The progress stub shows Recon as Running (specialists Waiting) until that brief is ready, then marks Recon Done and specialists Running. Recon also yields a deterministic context pack — bounded changed-hunk and context-pointer excerpts framed as untrusted evidence — prepended to every specialist system prompt inside a byte-identical shared head; the lines it delivers count as viewed evidence for every specialist ledger. The first specialist leads; the remaining three start when it finishes its first model response or after five seconds, and a lead failure never blocks them. Every specialist shares one system-prompt head plus a deterministic `prompt_cache_key` on OpenAI-compatible providers, and a specialist that reaches the wrap-up steer submits what it has and returns a `partial` outcome (outcomes are `complete`, `partial`, `failed`). Each completed report is judged once with `ORCHESTRATOR_JUDGMENT_MAX_TOOL_ROUNDS` evidence rounds plus one reserved publish round (at most one extra round, so evidence gathering can never starve `publish_thread`) and may publish one incremental `COMMENT` review. After the summary, one extra GitHub review uses the close outcome. Judgment assigns the published severity from the shared rubric. The server caps a tests-lens or test-path finding at `P2` and an unjudged finding at `P1`. A coverage gap keeps its own ceiling, `P1` or `P0` when `criticalPath` is set, including when a later run reaffirms it. A reaffirmation merges the higher severity, then passes through the cap that applies to that finding. A failed or unpublished judgment records that report as unjudged and does not publish its findings; the session continues for the remaining reports. Specialist ticks use shared status copy (`Waiting`, `Running`, `No findings`, `N findings`, `Failed`, `Not judged`); `N findings` counts accepted ledger placements (inline plus summary-only), not inline threads alone. A synthesis turn authors Size, Mergeability, and Blast Radius through `publish_summary`, running on the accepted ledger even when it is empty (a zero-findings review is a legitimate published review, not a degraded run). Synthesis runs on the partial ledger (accepted placements plus partial specialists) before any deterministic summary fallback. The final summary waits for all specialists. A failed specialist produces partial coverage. That coverage is a neutral check and an error commit status unless an open finding is already at or above `REVIEW_CHECK_FAIL_SEVERITY`, in which case it is published failure, status `failure`, and GitHub review `REQUEST_CHANGES`. If all specialists fail, the review posts a failure notice instead of a summary. A host abort before the summary is published stops the run without closing the check. The progress comment says `Stopped. The host aborted this run.` at a non-final revision, so the same work run can replace it with the summary. A summary that already published still closes the check.
- **Finding identity:** findings are identified by server-minted IDs in hidden GitHub markers, not database rows. Each run rebuilds the finding inventory from review threads and the summary comment; a failed or partial read keeps the check from `success` and turns new findings into summary-only rows. The `FINDING_HISTORY_*` settings are gone and ignored if still set.
- **Duplicate finding cleanup:** after inline publication and before the summary, a completed review replies on and resolves proven duplicate threads (`declare_duplicate` groups and same-ID copies). Each copy is handled under the PR mutex, which triage and verification also take for their resolve and receipt writes. Inside the mutex the review rereads the thread, skips the reply when the duplicate receipt is already there, and rereads again before resolving; a copy whose fresh read shows a human reply or an incomplete comment page is linked and left open. Each mutation records a publish intent keyed by kind, duplicate ID, canonical ID, and thread; recovery treats the receipt or the resolved state as exact evidence. A cleanup failure logs `review_duplicate_cleanup_failed` and does not fail the review. Mutex waits are bounded (`agent_work.thread_mutation_lock_timeout`).
- **GitHub publish recovery:** every non-idempotent review, ask, description, triage, verification, check, status, label, and reaction mutation runs through `publishOnce` (`src/state/publish.ts`), which records a `publish_intents` row before calling `PrSurface`. The row moves `reserved → mutating` in one `BEGIN IMMEDIATE` only while the work run is `running`, owns the lane epoch, shutdown is not requested, and no other mutating or overwrite-blocking intent holds the same `(pr_key, resource_target)`. The HTTP call goes through the mutation-only Octokit client: no retry or throttling plugin and a 20 s timeout, so one intent is exactly one request. Success records `reconciled` plus `publish_records`. A provider-proven rejection (for example a 422 whose validation entries are only inline anchor failures, including path resolution) becomes `mutation_failed`, which a fresh attempt may retry. Anything else runs exact-evidence recovery from `publish_records` or provider evidence (operation-intent marker or provider id) with at most three backoff lookups; unresolved outcomes become `outcome_unknown_recoverable` (lookup-only, swept at boot and periodically) or `outcome_unknown_terminal` (fail closed). An unknown outcome is never remutated. Reactions, labels, commit statuses, and finishing a check run cannot prove this attempt landed, so they stay fail-closed. A `reconciled` intent is not rewritten. A triage resume whose only miss is the pre-push head against `pushedHeadSha` continues through recovery, and a rebuild that cannot finish throws the remutate-forbidden `mutation_outcome_unknown`. With no local publish record, standing reviews, summary comments, and CI progress comments are first rediscovered from GitHub by their operation-intent markers, so a fresh data volume does not duplicate them.
- **Single active review:** one review may be pending or running per pull request. Intake keeps one active review slot in `pr_state` across automatic and slash review, and the in-process PR mutex serializes review, description, triage, and verification execution per PR. A duplicate `/review` is acknowledged but does not create another work run or change the active progress comment. `/review force` is the exception: it cancels the active run first (see below).
- **`/cancel`:** cancels the active review for the PR (auto or slash, pending or running) and aborts its Pi conversation. Acknowledgement replaces the **review progress comment** with a short failure-style notice: `Cancelled by @login. Run \`/review\` to try again.` (no Head/Source/CI/Recon/specialist table). No review is active → short reply only.
- **Cancellation publication fence:** `publishOnce` rereads the work run status and lane epoch inside the `reserved → mutating` transaction. A visible cancellation blocks new feature output without waiting for the observer. Cancellation notices and verdict cleanup remain permitted. Requests already in flight cannot be withdrawn.
- **Pending replacement cancellation:** terminal parent failure cancels its pending stale-head replacement even if a claim races the abort. The state-predicated write in `src/state/workRuns.ts` decides cancellation. A successful in-attempt handoff stays exempt. Cancelled work cannot publish new feature output. Unconfirmed cancellation logs `agent_work_replacement_cancel_failed` at error level and rejects.
- **`/review force`:** cancels any pending or running review for the PR (same mechanism as `/cancel`), then admits a fresh review that resolves the latest head at execution time, all in one intake transaction. Automatic and slash review intake serialize on the intake transaction. Concurrent restarts cancel and replace the preceding committed review in intake order, rather than replying already-in-progress. The acknowledgement completes the old run's check run and cancelled notice first, then posts the new run's queued progress stub and a short confirmation reply. With no active review it behaves like plain `/review`.
- **Review close cancel:** an effective close or merge cancels active review work, aborts its Pi conversations, and replaces the progress comment with the unchanged `PR merged.` or `PR closed.` notice. Close writes persistent review admission state in `pr_state` in the same intake transaction. Stale-head replacement creation reads that lifecycle in its own transaction before progress transfer. Later review admission creates no review or fresh progress comment, including `/review force` and stale-head replacements. Commands receive a closed/merged reply on their original thread. A newer provider-observed reopen permits admission, not an automatic review. Older close/reopen observations are ignored; terminal state wins equal timestamps and merged never reopens. Description, verification, ask and triage admission policies remain unchanged.
- **Triage close cancel:** when a PR is closed or merged, pending or running `/triage` work is cancelled in the same intake transaction and its Pi conversation is aborted. Acknowledgement posts a `-1` and a cancel notice. Separately, the writable checkout re-reads PR lifecycle state through `PrSurface` immediately before commit and push, and the publisher re-checks it after the push settles. Closed or merged state at either write-guard produces the terminal `closed` no-push notice: a push that raced the close is not reported as a success and resolves no `fixed` threads. Fork report-only, path, commit, push-or-nothing, never-force-push, and stale-head controls remain unchanged.
- **Review pointer link:** on the second and later orchestrated runs for a PR, the Files-tab pointer links to the existing **review summary comment** when it can be verified. The first completed summary uses plain text only.
- **Verdict review text:** terminal GitHub reviews explain why the app approved, requested changes, or withheld approval. They link to the review summary when its location is known. Verification uses the same wording and can link to the existing summary, but does not update it.
- **CI summary:** the progress stub and completed summary include a **CI** gate row for external checks on the PR head (excluding the installation's own check, identified by App id or work run `external_id`). Ack, ticks, and publish render that row from `pr_head_ci_state` at claim time and stamp `v=<version>` plus `fmt=<projection-format>` on the marker. They schedule a projection when the row is missing, `seeded_at` is null, or the row version moved after the write. Publish does not wait or poll GitHub. `check_run` and `status` deliveries write the table before the webhook returns 200 and schedule a debounced projection through `next_projection_at`. `pull_request` `opened`, `synchronize`, and `reopened` schedule it when the head row is missing or `seeded_at` is null. The projector takes one `getCiStatus` listing per job: it seeds an unseeded head or pending-refreshes a seeded pending/`unknown` head. It patches a cell when the marker `head` matches and marker `v` is older or the marker format is older at equal `v`. After a push, a terminal review's cell moves to the PR head GitHub reports; review meta and footer keep the reviewed head. It syncs the completed action-line CI phrase in the same edit, and re-enqueues when the row version or `progress-revision` moved after the write or a GitHub write failed. Missing or unseeded heads wait; a complete seeded empty snapshot is **No CI checks on this head**. On a failing rollup it downloads Actions logs by `check_run_id` first (workflow-run listing is fallback) and runs one LLM turn per distinct facts hash, stored on `authored`. A `workflow_run` or `check_suite` **completed** delivery schedules one head-scoped projection without writing facts. An incomplete check-run page (the retrieval cap) is **unavailable**, not passing or none, and is not a missing-Checks error. Known failures in that partial view stay failing. Missing **Checks: Read** shows a grant-Checks row; missing **Actions: Read** on a failing head keeps the failure row and adds a grant-Actions note. Those notes are for 403 `Resource not accessible by integration` only. A 404 is a missing resource, not a permission miss. The review still publishes either way. Caps: `REVIEW_CI_SUMMARY_*` in `reviewConstants.ts`.
- **Review summary action line:** the completed `## PR Agent Review` comment opens with one server-built `[!NOTE]` line: finding count (every P0–P3 table row), CI status (including no-CI when the head is seeded empty), and specialist coverage. It does not carry an LLM overview. Partial coverage lives on that line, not a second note below the table. A changed file that is in the checkout and was never opened is partial coverage too: the line says `with unread files` and does not say ready to merge. When a specialist also failed, the line keeps that exception and adds unread files. That case still closes a failing finding check as failure, and recovery uses the blocking count stored on the summary verdict. The check note names at most three unread paths. Persisted unread paths are capped at 500; the note still counts every unread file. Review recovery artifacts are schema version 8; older envelopes do not bind. The CI phrase is marker-wrapped so projection keeps it synchronized with the CI cell.
- **Review map link:** the summary links to the PR description's **review map** only when that section was published (read-first map mode). Short omit-mode descriptions have no map and no summary link.
- **Dispatcher concurrency:** review, ask, acknowledgement, CI projection, description, triage, and verification work runs are capped by **`REVIEW_CONCURRENCY`** (default `2`), **`ASK_CONCURRENCY`** (default `1`), **`ACK_CONCURRENCY`** (default `2`, also used for `ci_projection`), **`DESCRIPTION_CONCURRENCY`** (default `1`), **`TRIAGE_CONCURRENCY`** (default `1`), and **`VERIFICATION_CONCURRENCY`** (default `1`) in the in-process dispatcher (`src/agent/runtime/durable/dispatcher.ts`), with `INSTALLATION_GROUP_CONCURRENCY` per installation. There is exactly one process per data volume, so these are the whole deployment's limits.
- **GitHub rate-limit circuit (per run + shared MVP):** after three consecutive primary/secondary rate-limit retries are exhausted inside a review/ask run, nonessential GitHub tools short-circuit for the rest of that run; a successful GitHub request resets the consecutive-failure counter. Emits `github_rate_limit_circuit_opened` logs and `rate_limit_circuit_opened` review metrics. Opening a local circuit also upserts a **shared circuit** keyed by `installation_id` (`rate_limit_circuits` in `app_state.sqlite`, default cooldown `SHARED_RATE_LIMIT_CIRCUIT_COOLDOWN_MS` = 60s). `openRunRateLimitCircuit` (`src/state/rateLimitCircuits.ts`) opens the per-run circuit for both lanes. Other runs check that row at review/ask start and hydrate their local circuit open (`github_shared_rate_limit_circuit_honored`) so concurrent runs do not immediately re-burst the same installation. The CI projector reads the same row before any GitHub call and moves `next_projection_at` past the open window when it is open.
- **Tool surface:** production review, ask, and verification agents investigate through one `execute({ code })` tool. Scripts call only the installed workspace capabilities as `tools.*`. Review and ask install `listChangedFiles`, `readWorkspaceFile`, `searchWorkspace`, `findFiles`, `getWorkspaceDiff`, `getWorkspaceBlame`, and `resolveSymbol`. Verification installs `readWorkspaceFile`, `searchWorkspace`, and `getWorkspaceDiff`. `listChangedFiles` returns the admitted files in pages. Call it again with `continuation` until that value is null. `truncated` on that result means the pull request changes more files than were admitted. `searchWorkspace` takes optional `terms` and then ranks files by how many of the query and terms they contain. `findFiles` is fuzzy path lookup. Both are navigation; cite only lines read with `tools.readWorkspaceFile`. The FTS code index and `searchCodeIndex` are retired. The review orchestrator hands off through `submit_specialist_brief`, judges reports with `publish_thread`, and finishes through `publish_summary`. `execute` stays on the orchestrator session in every phase. Specialists submit one `submit_findings_report`. Tool-using sessions can call `report_obstacle` when a tool, prompt, input, or instruction blocks the step. The session stores that report in `agent_feedback` with the run, repository, pull request, reviewer or agent, model, and time. Credential-shaped text in the report is replaced before the insert. A storage failure returns `recorded: false` and the review continues. Reports are not read back into the session, so the four specialists do not see each other's reports. Description and triage still expose native workspace tools. GitHub reads and writes remain server-owned.
- **Pi-native agent runtime:** Set **`PI_PROVIDER`/`PI_MODEL`** for general sessions, optional **`PI_ORCHESTRATOR_*`** and **`PI_FALLBACK_*`**, and an optional **`models.json`** catalog. The session seam drives Pi Durable 1.6.0 conversations. Shared `send` fails when the loop settles on an unrecovered provider error. A successful internal transport retry still succeeds. Public cancellation stays fallback-ineligible even during retry backoff with no replacement assistant turn. Tool-round budget stops are not provider outages. Retry escalation is deterministic from the durable attempt count: attempt 2 and later get a doubled tool-round budget (capped at `ESCALATED_TOOL_ROUNDS_CAP`) and, when `PI_FALLBACK_*` is configured, run on the fallback model. A review whose primary model fails retires its session and recovers on the next durable attempt, a fresh `work_run_attempts` row; the former in-run fallback restart is deleted. Escalation never widens tool access, workspace path policy, repository-policy trust, or the Code Mode capability boundary.
- **Code Mode:** Review, ask, and verification investigate the local PR workspace through one `execute({ code })` tool. Scripts call `tools.*` workspace capabilities. Submit and publish tools stay native. The cell value is the last top-level expression statement, with or without a trailing semicolon, and trailing comments and empty statements are ignored, while declaration, control-flow, and explicit `return` endings keep their own semantics. Line-comment endings participate in newline statement splitting for LF, CRLF, and CR; a following call, index, template, or infix operator stays in the same expression, while prefix `++` and `--` still start a new statement. Semicolons inside strings do not split statements. QuickJS interrupt, an 80ms guest CPU budget, a 25-call cap, a 15s wall clock, and bounded serialization keep a script from freezing the process. `codeMode.executorKind` in `Config` runs compiled production cells on worker threads and keeps TypeScript sources (Vitest, dev) in-process; the run setup passes it down as a parameter. Session abort (cancel or supersede) aborts the script even if the JavaScript uses `try/catch`. Compiled production restores `CodeModeHostHalt` from a structured `hostResult.halt` field so worker-thread host calls stay uncatchable. `review_run_completed` counts those halts in `codeModeCapHits` beside `modelTurnCount`. Reasons are `workspace_calls`, `pool_queue`, `pool_wait`, `cell_wall`, `guest_cpu`, `source_bytes`, `state_bytes`, and `allocation`. Cancel, execution errors, and a session state conflict stay at zero. Caps stay as they are.
- **Bot identity** for self-suppression is cached per **`GITHUB_APP_ID`**, so multiple GitHub Apps in one process do not share the same cache entry.
- **`WEBHOOK_TIMEOUT_MS`** (code constant, default `10000`) is the webhook intake response budget. Intake that is still interruptible when this budget minus `GITHUB_WEBHOOK_RESPONSE_MARGIN_MS` expires returns **`503`**. A `submit` already inside its uninterruptible commit is allowed to finish, and a successful commit returns **`200`**. Work runs are supervised separately by the dispatcher.
- **`/triage`:** trigger-only autofix work type. Post `/triage` on the PR conversation to triage unresolved findings from current specialist runs and recognized legacy lens threads. Reply `/triage` inside a bot inline finding thread to scope the run to that finding. `/triage preview` posts **`## PR Agent Triage Preview`** with the would-be unified diff for the same scope and does not push or change threads. `/triage all` then replays those stored hunks (full PR even when posted on a thread; optional `exclude <thread ids>`). Bulk without a completed `triage_preview` for the same PR head is a report-only refusal and does not check out. It does not start a second agent run. Bare `/triage` still applies without a preview. Triage skips fork PR pushes, fixes same-repo findings in an isolated writable checkout, commits with validated messages, and pushes without force. A `dismissed` verdict requires an authorized maintainer decision from a `User` author in `MAINTAINER_DECISION_ASSOCIATIONS` on the matching finding thread; ordinary, missing-metadata, and bot replies remain untrusted evidence. After a successful push, it replies on `fixed` threads then resolves them. It resolves `already-resolved` and `dismissed` threads even when push is stale or there were no commits (`skipped` stays open). It upserts **`## PR Agent Triage`**. The report stamps a CI rollup marker for the evaluated or pushed head. The projector patches that marker when facts for that head move, including after a push whose work-item head is still the pre-push SHA. Fix commits use the human `/triage` issuer as git author and committer (profile or id-based noreply email) with a GitHub App `Co-authored-by` trailer; bot/app or unresolvable issuers keep App authorship without a redundant App co-author. Push still uses the installation token (App). The bot push triggers a normal `synchronize` verification run. Close/merge cancellation is terminal and no-push, including when the branch remains available. The writable workspace `searchWorkspace` may grep the checkout internally, but normalizes each result and applies the canonical sensitive/control-path policy to the path and its resolved symlink target before returning the path or matching text. Blocked matches are omitted and reported only with a non-sensitive filtered indicator; literal-query, timeout, and result-cap behavior remains unchanged. Its process buffer now uses `LOCAL_WORKSPACE_SEARCH_MAX_TOTAL_BYTES`, the same cap as pinned searches. Buffer cuts return partial results with `truncated: true`; colon-containing paths use the shared NUL-delimited parser. GitHub App needs **Contents: read/write** for this command.
- **Verification runs:** auto-triggered on `pull_request` `synchronize` when `FEATURE_VERIFICATION=auto` (the default), or on demand with `/verify` when the feature is `manual` or `auto`. `off` stops new enqueue. Work already queued still runs. Read-only: re-checks open bot inline findings against the current head. Automatic and slash-triggered runs share one Local PR workspace object for the session directory, search, and diffs. `searchWorkspace` searches permitted tracked paths through that workspace's literal-search operation, then applies the same sensitive/control-path policy as triage before the result cap. Blocked paths are omitted and counted; the count is logged as `verification_search_matches_filtered`. Search output that exceeds `LOCAL_WORKSPACE_SEARCH_MAX_TOTAL_BYTES` is treated as truncated, not a failed search. `getWorkspaceDiff` returns the cached GitHub base-to-head patch. `availability` is `available`, `unchanged`, or `unavailable`. `reason` separates a patch-budget omission, a missing or empty upstream patch, a rename's previous path, and an incomplete changed-file list. An empty `diff` does not prove the path is unchanged. Deleted paths still return their cached patch when GitHub supplied one. Private Git metadata stays outside the agent-visible tree. **Fixed** and **already-resolved** threads are resolved without a new verdict reply; if a prior verification stub exists, it is edited in place to a short fixed/already-resolved line so a stale still-open signal is not left behind. An unanswered finding objection gets one separate reply, including on those verdicts. The reply starts with `**Verification reply**:`, carries a `pr-agent:objection-answer` marker, and is never an edit of the verification stub. A `not_objection` classification is journaled and not posted. One run answers at most `VERIFICATION_MAX_OBJECTION_ANSWERS_PER_RUN` objections. **Still-open** findings on files changed in the push update one verification stub comment in place. **Dismissed** findings require an authorized maintainer decision from a `User` author in `MAINTAINER_DECISION_ASSOCIATIONS` on the matching finding thread; other reply text is untrusted evidence. Verification edits that stub (evidence + policy suggestion) and then resolves the thread. No ack reaction, progress comment, or summary comment is posted for a successful run. A terminal failure writes `verification_failure` for the bound head so the CI projector can inject ``Run `/verify` to try again.`` into the CI cell. It does not edit the review comment and does not open finding-thread replies or a new comment per finding. Silence alone is not proof of success: a stale-head skip is also quiet. With no unresolved open findings, including when all fetched threads are resolved, the run checks cancellation/supersession and bound/live head equality before clean completion and failure-signal cleanup. A stale empty run preserves the existing failure signal and CI revision. At this empty gate or the existing late non-empty publish gate, a head mismatch logs `verification_publish_skipped` with `reason: "stale_head"` and both SHAs, and completes degraded (`publishDegraded`) without verification publication or retries. These checks observe head equality; they do not atomically bind publication against later pushes. An escalated attempt (attempt 2 or later) re-checks only the `MAX_ESCALATED_VERIFICATION_INVENTORY` oldest open findings and records `inventory_narrowed` as a degradation reason; the remainder waits for a later attempt or run. Slash `/verify` has no automatic replacement. A later auto synchronize run is a separate item.
- **Policy suggestions for dismissed findings:** when triage or verification dismisses a finding, the bot drafts a paste-ready `.pr-agent/*.mdc` suggestion. Verification grounds the suggestion in the base snapshot. When that snapshot has usable `.mdc` rules and exactly one rule matches the finding path, the suggestion is an append fragment. Otherwise, including a missing snapshot, it proposes a new `.mdc` starter. Triage always proposes a new `.mdc` starter without reading policy.
- **`/ask` and App-bot mentions:** interactive Q&A about PR code (and conversational follow-ups in the same thread). Mention matching uses the App bot login, not the literal string `@bot`. Shared intake admits work through durable actor, repository, and installation token buckets plus outstanding limits before inserting the `work_runs` row. When configured, the installation provider budget reserves a bounded token amount; each distinct ask computation's known Pi usage is counted once, and unknown usage consumes the reservation. The budget window rolls on wall-clock time while outstanding reservations stay reserved. Excess asks receive one static throttling reply and create no work run. Ask runs are not serialized by the PR mutex. `@`-mention of the app bot (same allowlist as slash commands) on the PR conversation or an inline review thread also admits an ask; the run loads the shared pull request discussion into the prompt. Each run also loads a read-only untrusted `ci_state` block from `pr_head_ci_state` (rollup, version, check names). No CI tool is added. Explain-only — no severity/dismiss mutations. A terminal **Ask failure reply** is posted only when durable state has no confirmed delivered answer, and that reply is idempotent under the `ask:failure_reply` operation-intent key. Repeated accepted deliveries of one triggering comment (same installation, PR, comment surface, and comment ID) join the retained ask run in the intake transaction before quota admission: no second answer, reservation, ack, or new work run, even after the first run finishes, and the join is a quiet success rather than a failure on dashboards. Intake contention fails the delivery and relies on GitHub redelivery; there is no intake retry loop. The join lasts until retention deletes the run (`AGENT_WORK_RETENTION_SECONDS`).
- **Lightweight review completion:** automated reviews on docs-only trivial PRs may finish without an **orchestrated review run** under the **trivial change exemption**.

## Large PRs and GitHub rate limits

- Pinned workspace search defaults to 20 results and caps requests at 200,
  including ranked searches and Git fallback. It reads selected matching lines
  by byte offset instead of retaining whole matched files. The existing
  50,000,000-byte output ceiling applies during line materialization.
  Omitted matches set `truncated: true`; request a narrower search to continue.
  Writable triage retains its existing post-filtered result policy.
- **`@octokit/plugin-throttling`** paces all installation-token REST calls (review tools, publish, reactions). File listing and patch caps are code constants in `src/settings/reviewConstants.ts`: `MAX_PR_FILES_LISTED` (default `300`), `MAX_PR_FILES_PATCH_BYTES` (default `500000`).
- Throttle hooks log `octokit_on_rate_limit` / `octokit_on_secondary_rate_limit`. Circuit open logs `github_rate_limit_circuit_opened`. Capture a redacted sample when debugging production limits.
- Installation-token caching and freshness checks share `src/github/installationToken.ts`. Executors import it directly; the dispatcher does not re-export authentication.

## Deployment

### Docker and Docker Compose

- **Stack:** [docker-compose.yml](../docker-compose.yml) runs one **`pr-agent`** service. It serves `/webhooks`, `/health`, and `/ready`, runs every work kind, and keeps all durable state on the named **`pr-agent-data`** volume mounted at `/data` (`SQLITE_DIR=/data`).
- **Data volume:** `/data` holds `app_state.sqlite` (with `-wal` and `-shm`), `pi_durable.sqlite` (with `-wal` and `-shm`), `pr-agent.lock.sqlite`, and `archive/<timestamp>/` copies left by the `pi_durable.sqlite` reset. Back up the whole volume while the service is stopped. `docker compose down -v` deletes it.
- **One writer:** the process holds `BEGIN EXCLUSIVE` on `pr-agent.lock.sqlite` for its lifetime. A second process on the same volume fails fast at boot; a `SIGKILL` or OOM releases the lock with the process. Never mount the volume into two containers, and never run more than one replica.
- **Stop-first updates:** `docker compose up -d` stops the old container before it starts the new one. The Compose file also sets `deploy.update_config.order: stop-first` for Swarm-style orchestrators. `stop_grace_period: 40s` stays above `SHUTDOWN_GRACE_MS` (default 25 000) plus 5 s, so the shutdown sequence finishes before Docker kills the process.
- **Schema:** `app_state.sqlite` is created at first open with `PRAGMA user_version = 1`. There are no migrations to run. A file with a newer `user_version` fails startup rather than being downgraded.
- **Durability:** both databases run `PRAGMA journal_mode = WAL` and `PRAGMA synchronous = FULL`, and boot refuses to continue unless `synchronous` reads back `2` on each. Keep the volume on a local disk; network filesystems break SQLite locking.
- **Image:** multi-stage `Dockerfile` (Node 24.22.1 LTS) running `node dist/index.js` as the non-root `node` user, with `VOLUME /data` and `SQLITE_DIR=/data`. Runtime listens on **`PORT`** (pinned to **7224** in Compose and [`.env.example`](../.env.example)). The runtime stage installs Debian `git` from `node:24.22.1-bookworm-slim` (2.39.x). That image supplies npm 11.19.1. Pinned workspace search runs on fff in a child process forked on first use, with `git grep -nF -I -z` for files fff does not index and as the fallback. Triage search uses `git grep` alone. Both apply `maxResults` plus `LOCAL_WORKSPACE_SEARCH_MAX_TOTAL_BYTES` to the result. `git grep` does not pass `--max-count` (Git 2.40+). The image ships the `@ff-labs/fff-bin-*` platform package for its architecture; a host that cannot load it logs `workspace_search_fff_fallback` and searches with `git grep`.
- **Health:** `GET /health` and `GET /ready` both answer only while `app_state.sqlite` responds to `SELECT 1` and the agent harness is open; otherwise they return `503`. The image `HEALTHCHECK` and Compose healthcheck hit `/health`. During a `pi_durable.sqlite` reset the harness is briefly closed, so a probe can fail for a moment while `/webhooks` keeps answering `200`.
- **Webhook URL:** set GitHub to `https://<host>/webhooks`. The process binds HTTP on `7224`. Production Compose publishes that HTTP port only. Maintainer-local Caddy and a Cloudflare quick tunnel live in [docker-compose.dev.yml](../docker-compose.dev.yml). A public `http://<host>:7224/webhooks` URL is rejected except for loopback.
- **Daemon restart:** `pr-agent` sets `restart: unless-stopped`. A daemon restart starts it if it was running. It does not start a container you stopped with `docker compose stop`. Boot runs Phase A recovery before it serves, so a restart after a crash resumes durable work without operator action.
- **Provider API keys** (for example **`OPENAI_API_KEY`**, **`ANTHROPIC_API_KEY`**, **`GOOGLE_GENERATIVE_AI_API_KEY`**) are loaded by [`src/settings/slices/models.ts`](../src/settings/slices/models.ts) into `models.providerKeys`. They are optional at boot. Set them in `.env` beside the GitHub fields or reviews fail at runtime. `GET /health` and `GET /ready` stay green without a key.
- **Custom Pi providers (`models.json`):** three ways to get a catalog into the container at `/app/models.json` (process cwd), or elsewhere via **`MODELS_JSON_PATH`**:
  1. **Build-context copy (default image behavior):** if repo-root `models.json` is present when you `docker build`, the runtime stage copies it to `/app/models.json`. If the file is absent, the build still succeeds (built-ins only). Dokploy **Patches** can `create` File Path `models.json` after clone and before build — no `MODELS_JSON_PATH` and no Dockerfile edit required when using the image cwd.
  2. **Runtime bind mount:** the committed [docker-compose.yml](../docker-compose.yml) does not mount `./models.json`. Copy [`models.json.example`](../models.json.example) to a host file, then add the fragment below, or rebuild with the file in context, or set `MODELS_JSON_PATH`. Create the host file **before** mounting. Docker turns a missing host path into a directory.
  3. **`MODELS_JSON_PATH`:** mount the catalog anywhere and point the env var at that path.

  Example Compose fragment for a host mount:

  ```yaml
  services:
    pr-agent:
      volumes:
        - ./models.json:/app/models.json:ro
  ```

- **Secrets:** never commit `.env`; keep Compose files off public pastebins. The data volume holds agent conversations with repository excerpts; treat it as sensitive.

```bash
cp .env.example .env
# paste a generated one-line or base64 GitHub App PEM before the first start
docker compose build
docker compose up -d
```

Compose sets `environment.PORT=7224` and **`7224:7224`** publishing. For a host port clash, change **`ports`** to for example **`7227:7224`** and keep container **`PORT`** at **7224**.

**Requires Docker Engine with Compose v2.** `env_file` defaults to **`.env`**; use host env **`PR_AGENT_ENV_FILE`** for an alternate path.

The production overlay ([docker-compose.prod.yml](../docker-compose.prod.yml)) removes the `.env` default: it fails unless `PR_AGENT_ENV_FILE` names the env file. That name is Compose-only, not a `loadConfig()` key.

```bash
PR_AGENT_ENV_FILE=/abs/path/to/.env docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

### Runtime (Effect TS)

- **Interrupted publish:** completed recovery without a usable result stops the
  run through its existing terminal hook. The intent becomes
  `outcome_unknown_terminal`; that is a local decision, not proof that GitHub
  rejected the change. Failed or incomplete evidence reads stay
  `outcome_unknown_recoverable` and are swept again. Reactions, labels, commit
  statuses, and check completion without exact evidence take this bounded
  fail-closed path, never a second mutation. Open-check repair does not select
  or log that check again.
- **Single process:** [`src/index.ts`](../src/index.ts) loads config, acquires the single-writer lock, opens `app_state.sqlite` and the Pi harness, runs boot Phase A and Phase B, and starts the Effect HTTP server with one `NodeRuntime.runMain`. Invalid config fails as `StartupConfigInvalid` before anything opens.
- **Intake:** [`processWebhookRequestEffect`](../src/effect/programs/processWebhookRequestEffect.ts) verifies signatures, parses payloads, and maps the validated event through [`toIntakeCommand`](../src/webhook/intakeCommand.ts), resolving bot identity only when explicitly required. [`runDelivery`](../src/state/intake.ts) then commits dedupe, lifecycle, admission, and `work_runs` rows in one `BEGIN IMMEDIATE` and wakes the dispatcher. `webhook.handle` and `webhook.dispatch` spans carry the event, delivery id, and outcome. Tagged failures are logged, then `catchTags` maps them to the same `401`, `400`, `422`, and `503` plain-text bodies. The commit is synchronous, so a response-budget timeout cannot abandon a commit already in progress. A successful commit returns `200`.
- **Execution:** the [dispatcher](../src/agent/runtime/durable/dispatcher.ts) claims due work runs and runs `review` as `reviewOrchestratorTask`, `ask`/`description`/`triage`/`verification`/`ci_projection` as `featureAttemptTask`, and `ack` directly. PR-surface I/O and LLM runs happen in the feature executors under [`src/agentWork/executors/`](../src/agentWork/executors/).
- **Shutdown:** `SIGTERM` or `SIGINT` makes `/webhooks` return `503` and sets `shutdownRequested`, which blocks every new `reserved → mutating` publish transition. The dispatcher and CI timers pause, in-flight GitHub writes get up to `SHUTDOWN_GRACE_MS` (default 25 000) to settle alongside the bounded `ANALYTICS_SHUTDOWN_TIMEOUT_MS` flush, then `harness.close()` runs, followed by `app_state.sqlite` and the lock. Work still running at that point resumes after restart: review tasks continue from their checkpoint, and interrupted feature attempts are aborted and retried. An unexpected `harness.closed` exits the process non-zero, and the restart policy starts it again.
- **Zero-503 `pi_durable.sqlite` reset:** see [the reset runbook](agent-work-ops.md#pi_durable-reset). `/webhooks` keeps answering `200` throughout.

### Local development edge cases

- **Primary start** is `docker compose -f docker-compose.dev.yml up -d --build`. That file starts one pr-agent service on the `pr-agent-data-dev` volume, Caddy, and a Cloudflare quick tunnel to the pr-agent service. `dev/mock.env` has no PEM. The boot script generates one at process start. Print the public webhook URL with `node dev/print-public-webhook-url.cjs` and paste it on the GitHub App. The trycloudflare hostname changes on restart. Probe the laptop side with `curl -k https://pr-agent.localhost/health`. If the name does not resolve, add it to `/etc/hosts` or pass `curl --resolve`. Do not mix that file with `docker compose up`.
- **`npm run dev`** runs `node --watch $( [ -f .env ] && printf '%s' --env-file=.env ) src/index.ts`. When `.env` is absent, that is `node --watch src/index.ts`. When `.env` is present, that is `node --watch --env-file=.env src/index.ts`. Node strips erasable TypeScript without a loader. Imported-source changes restart the process. Restart manually after `.env`, configuration, or other unwatched input changes. It uses `SQLITE_DIR` (default `./data`); a second `npm run dev` on the same directory fails fast on the lock, and so does a host process while the dev container holds the same files.
- **`GITHUB_APP_PRIVATE_KEY` must be a valid PEM key**. For local-only boot: `openssl genrsa 2048 > key.pem` and set the escaped PEM in `.env`. The example blob in `.env.example` fails `crypto.createPrivateKey()`.
- The Compose `cloudflared` service is the public webhook path. Do not start a host smee or `cloudflared` process unless that service cannot reach Cloudflare.
- Host, CI, images, and the site workspace use Node 24.22.1 LTS. The supported range is `^24.22.1`. npm `>=11.19.1 <12` remains required, including commands launched from `site/`. Older npm releases do not provide the required release-age settings.
- Run `npm ci` for a clean contributor installation against the root lockfile. It replaces the installed tree; no global package-manager installation is needed.
- **Vercel** uses explicit commands in [`site/vercel.json`](../site/vercel.json). The hosted npm can fall below the required version. Installation first runs `npm install --global --prefix /tmp/pr-agent-npm --ignore-scripts --engine-strict --min-release-age=7 npm@11.19.1`. This isolates the toolchain without changing the hosted npm. From the configured `site` directory, installation then runs `cd .. && /tmp/pr-agent-npm/bin/npm ci --workspace=pr-agent-landing --include-workspace-root=false`. The build runs `/tmp/pr-agent-npm/bin/npm run build --workspaces=false` in `site/`. Vercel selects 24.x from `^24.22.1`. Check dashboard Node and command overrides separately. Root install policy applies to the app. The site serves `/llms.txt`, `GET /llms?query=`, and `GET /llms/json?query=` from [`site/lib/llmsKnowledge.ts`](../site/lib/llmsKnowledge.ts).
- **Docker image** installs build dependencies with `npm ci --workspaces=false` and production dependencies separately with `npm ci --omit=dev --workspaces=false`. Lifecycle scripts stay disabled, including for native packages. Runtime keeps the official Debian slim base, Git, certificates, the non-root user, and direct `node dist/index.js`; no package manager or compiler runs in the production process. [`.dockerignore`](../.dockerignore) keeps only the site's manifest for the shared lockfile.

### TLS in front of Compose

The product binds HTTP only. GitHub webhook URLs must be HTTPS except localhost. Put a terminator you already run in front of `pr-agent` on `7224`. Example Caddyfile on the same host:

```
example.com {
	reverse_proxy 127.0.0.1:7224
}
```

Set the App webhook to `https://example.com/webhooks`. Production Compose still has no Caddy, nginx, or certificate. Do not add Caddy to [docker-compose.yml](../docker-compose.yml).

Maintainer-local HTTPS is [docker-compose.dev.yml](../docker-compose.dev.yml) plus [dev/Caddyfile](../dev/Caddyfile). That Caddy uses `tls internal`. GitHub does not trust it. The same Compose file starts `cloudflared` for App deliveries.

A host panel such as [Dokploy](https://dokploy.com) or [Coolify](https://coolify.io) is the same job: terminate TLS and forward to `pr-agent` on `7224`. Use the panel domain as the GitHub App webhook host. Keep the `/data` volume persistent, run one replica, and use a stop-first (recreate) update so two containers never share the volume. Do not add a panel-specific compose file. VPS and panel picks: [README.md](../README.md#recommended-hosts).

Canonical install steps live in [README.md](../README.md) **Installation**.

## Development

Maintainer-local start is one Compose file, then optional host Node if you want source watching.

```bash
docker compose -f docker-compose.dev.yml up -d --build
node dev/print-public-webhook-url.cjs
curl -k https://pr-agent.localhost/health
```

If that name does not resolve, add `127.0.0.1 pr-agent.localhost` to `/etc/hosts`, or pass `--resolve pr-agent.localhost:443:127.0.0.1` to `curl`.

The service listens on `7224`. The Caddy site name is `pr-agent.localhost`. The public GitHub URL is the printed trycloudflare host plus `/webhooks`. Production `docker compose up` is a different path. It has no Caddy and no tunnel.

### Scripts

| Script                                                        | Purpose                                                                                                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `node --env-file-if-exists=.env src/index.ts` / `npm run dev` | Run `src/index.ts` (the whole service)                                                                                               |
| `npm run dev`                                                 | Auto-restart dev entry                                                                                                               |
| `npm run build`                                               | Compile to `dist/`                                                                                                                   |
| `npm run start` / `node dist/index.js`                        | Run compiled `dist/`                                                                                                                 |
| `npm run typecheck`                                           | `tsrs --noEmit -p tsconfig.json` (`src/`, `test/`, Vitest configs). `npm run build` uses `tsrs -p tsconfig.build.json` (`src/` only) |
| `npm run lint`                                                | Oxlint, zero warnings (includes `site/`)                                                                                             |
| `npm run lint:backend`                                        | Oxlint, zero warnings, excluding `site/`                                                                                             |
| `npm run lint:fix`                                            | Oxlint with safe fixes                                                                                                               |
| `npm run fmt`                                                 | Format with Oxfmt                                                                                                                    |
| `npm run fmt:check`                                           | Check formatting                                                                                                                     |
| `npm run check:code`                                          | `typecheck` + `lint` + `fmt:check`                                                                                                   |
| `npm run check:effect-versions`                               | Verify pinned Effect deps                                                                                                            |
| `npm run check:prod-deps`                                     | Clean installed backend production graph guard                                                                                       |
| `npm run check:commit-messages`                               | Lint PR commits against /commit conventional rules (`--base`, `--head`)                                                              |
| `npm run test`                                                | Vitest unit suite (`test/**/*.test.ts` except `test/integration/**`)                                                                 |
| `npm run test:watch`                                          | Vitest watch mode                                                                                                                    |
| `npm run test:integration`                                    | Vitest integration suite on temporary `SQLITE_DIR`s; needs no Docker or database server                                              |
| `npm run verify`                                              | Integration suite on a disposable `SQLITE_DIR`, plus PRAGMA read-backs, written to `verify-artifacts/`                               |
| `npm run site:dev`                                            | Landing site local dev (`pr-agent-landing`)                                                                                          |
| `npm run site:build`                                          | Landing site production build                                                                                                        |
| `npm run check:site-design`                                   | Landing site design-system check against `scripts/baselines/site-design-baseline.json`                                               |
| `npm run site:generate-og`                                    | Generate landing OG assets                                                                                                           |

`npm run test:integration` gives every suite its own temporary `SQLITE_DIR`, so suites run in parallel without shared state. `npm run verify` runs it against a fresh temporary `SQLITE_DIR`, reads back `PRAGMA synchronous` on both databases, and writes `verify-artifacts/<stamp>.md`. It refuses a non-empty `SQLITE_DIR` unless `--use-env` is passed.

`npm run typecheck` runs `tsrs --noEmit -p tsconfig.json`. `npm run build` runs `tsrs -p tsconfig.build.json`. [`.oxlintrc.json`](../.oxlintrc.json) sets `options.typeAware` to false, so lint does not load `oxlint-tsgolint`. It does load `@interfere/landmines`. Registry install policy lives only in [`.npmrc`](../.npmrc): `min-release-age=7`, `min-release-age-exclude[]=@tanstack/redact`, `min-release-age-exclude[]=@interfere/landmines`, `legacy-peer-deps=true`, `ignore-scripts=true`, and `engine-strict=true`. Those two package names are the exclusions. npm exclusions match package names or globs, not exact versions. Every other package still waits seven days. `npm run test` runs the unit files as two Vitest projects: `unit` at the 5s default, and `slow` at 90s for the git, HTTP, and settle files named in `vitest.config.ts`. Integration keeps its budget in `vitest.integration.config.ts` (90s).

Both lint scripts pass `--deny-warnings`. `npm run check:guards` locks suppression markers with `lint-suppressions(src)` (4) and `lint-suppressions(test)` (0) in the static baseline. Counts only shrink.

### Effect version gate

`npm run check:effect-versions` enforces direct pins and installed shell versions:

- `effect@4.0.0`
- `@effect/platform-node@4.0.0`

The Node adapter's installed `effect` and transitive
`@effect/platform-node-shared` must also be `4.0.0`. `@effect/platform`
must not be a direct dependency.

The initial Effect 4 adapter migration required five temporary release-age exceptions. Those exceptions expired on October 8, 2026. The current npm policy excludes only `@tanstack/redact`.

`npm run test` explicitly runs this gate before Vitest. Lifecycle hooks are not used because dependency scripts stay disabled.

Agent index: [AGENTS.md](../AGENTS.md).

## Security

- Treat `WEBHOOK_SECRET` and app private keys as production secrets.
- **`/ask`** applies deterministic outbound redaction (tokens, host URLs, PEM blocks) before posting replies; obvious bot-internals probes get an **Ask meta refusal** without an LLM call.
- **Triage workspace boundary:** Direct reads, search results, edits, staging, and commits use the canonical triage sensitive/control-path policy. Every `.jsonc` file, including nested and case variants, is a control-plane path. Verification search blocks these paths too. Search may inspect the checkout internally, but it never returns a blocked path or its matching text; symlink targets are resolved before the decision. `WritablePrCheckout.commit` rejects symlinks, symlinked ancestors, non-file targets, and paths resolving outside the checkout before mutating the Git index, and stages/diffs validated canonical paths as literal pathspecs while preserving tracked-file deletions.
- **Verification workspace search:** `searchWorkspace` uses the Local PR workspace literal-search operation and that same sensitive/control-path predicate on permitted tracked paths. Blocked hits are withheld before the result cap and counted; the count is logged as `verification_search_matches_filtered`. Search output over `LOCAL_WORKSPACE_SEARCH_MAX_TOTAL_BYTES` returns as truncated rather than failing. Read tools keep their existing path gates. Diff tools read cached PR patches and keep the sensitive-path gate without requiring a deleted file to exist at head.
- **Triage report comments** run through the same public-output redactor before upsert to GitHub (normal and report-only paths).
- **Telemetry redaction** uses one canonical recursive sanitizer at logging and analytics boundaries (`src/security/sanitizeTelemetryValue.ts`). It handles `AppError` messages, contexts, raw values, causes, arrays, objects, Error fields, and circular references across camel- and snake-case payloads. Secret-shaped strings and sensitive keys are replaced while safe codes, classifications, work IDs, provider kinds, and resource identifiers remain available. PostHog is optional: enabled only when `POSTHOG_PROJECT_TOKEN` is non-empty and sink construction succeeds (`src/analytics` facade; empty token means no SDK load). Failed construction or reinitialization restores a no-op sink with analytics disabled; the PostHog `before_send` sanitizer is the final recursive backstop for explicit and autocaptured exceptions.
- **Classified external failures.** Terminal and retried agent-work events carry `failure_domain` (`provider` | `github` | `internal` | `unknown`) and `error_kind` (provider: `auth`/`quota`/`billing`/`rate_limit`/`timeout`; GitHub: `auth`/`forbidden`/`not_found`/`validation`/`rate_limit`; workspace Git: `timeout`/`auth`/`not_found`/`git`; plus `validation`/`publish`/`cancelled`/`superseded`/`unknown`). Query those fields on `"work completed"` when `outcome=failed`, and on `"work item retried"` (a failed attempt returning as `retry_scheduled`; adds `attempt_count`, `next_attempt`, `retry_disposition`, and `escalation_kinds`). Failed and retried events also send a sanitized, length-bounded `error_message`. GitHub-domain failures add `http_status` and `request_path` when those values are known from structured error fields. Missing status or path is omitted. `cause_chain` stays on evlog only. Handled durable outcomes do not send `$exception`. A provider failure also keeps `provider_error_kind`. Matching evlog fields use camelCase (`failureDomain`, `errorKind`, `errorMessage`, `httpStatus`, `requestPath`) on `review_not_published`, `agent_publish_fallback`, `agent_work_failed`, and siblings. Lifecycle cancellation/supersession and structured provider/GitHub origins, including causes, outrank ambiguous wrapper text. Classification is logs/analytics only. PR-facing failure notices stay neutral.
- **Work completed.** Every work run that completes sends one `"work completed"` event (`src/analytics/workCompleted.ts`). The distinct ID is the installation. Shared properties: `work_item_id`, `work_type`, `outcome`, `reason`, `duration_ms`, `attempt_count`, `owner`, `repo`, `pr_number`, `head_sha`, `publish_attempts`, `publish_step_count`. Outcomes are `published`, `degraded`, `failed`, `superseded`, `lightweight`, and `cancelled`. `duration_ms` is the wall clock from the work run's first attempt start, including a later resume. A cancel that wins after the executor has started sends `outcome=cancelled` and the cancel reason. A cancel before the executor starts does not send this event. Degraded adds `degraded_reason` (`publish_retry` | `judgment_degraded` | `brief_fallback` | `rate_limit_circuit` | `validation_failure` | `tool_call_error` | `durable_degradation` | `ci_unavailable`). Every event also carries `ci_rollup`, `ci_failing_count`, and `ci_authored` from `pr_head_ci_state` when the load succeeds (missing row is `none` / 0 / false). `ci_unavailable_reason` is set when rollup is `unknown` (incomplete check-run page). A published review in that state is `degraded` with `degraded_reason=ci_unavailable`. One `"ci state changed"` event fires when `rollup` moves, not on every version bump. Failed adds `failure_domain`, `error_kind`, sanitized `error_message`, and optional `http_status` / `request_path`. Superseded publish and cancelled lightweight review emit those outcomes. Already-published replay, stale-head replacement, and no-open-findings short-circuit emit no completion envelope. Committed cancellation and supersession, including intake transitions, emit separate lifecycle terminals only after commit. A later check-run or cleanup failure does not send a second event. `"work item retried"` describes a charged attempt returning as `retry_scheduled` and uses the same failure-detail keys. `work execution stopped` describes an attempt stopping, not a committed durable terminal. No telemetry backfill is performed.

  When the execution prepared or reused a Local PR workspace, `"work completed"`, `"work item retried"`, and the `execution` AI span also carry `workspace_checkout_mode` (`full` | `sparse` | `sparse_fallback`), `workspace_fallback_reason` (`fetch_timeout` | `git_failed` | `git_low_speed`), `workspace_checkout_reused`, `workspace_fetch_attempts`, and `git_*` fields for the last fetch (`git_error_code`, `git_error_kind`, `git_exit_code`, `git_signal`, `git_killed`, `git_timeout_source`, `git_elapsed_ms`). A sparse fallback adds the same `fallback_git_*` fields for the failed full fetch. Git stderr stays in logs and error context only. See [workspace checkout diagnostics](agent-work-ops.md#workspace-checkout-diagnostics).

  `publish_attempts` counts real publish-breakage recoveries only and starts at 0; deterministic summary salvage from the ledger does not count. `publish_step_count` is the healthy step shape. A clean four-specialist review plus synthesis is `publish_attempts=0` and `publish_step_count=5`. `publish_attempts > 0` is `degraded_reason=publish_retry`, which means real breakage only. Tokens and phase latency live on work spans, not on this envelope. The event omits prompts, diffs, tool payloads, and `cause_chain`. An empty `POSTHOG_PROJECT_TOKEN` keeps capture as a no-op.

- **Work spans.** Agent lifecycle events (`AGENT_EVENTS_ENABLED`, through the telemetry bridge to evlog) and PostHog (`POSTHOG_PROJECT_TOKEN`) are independently enabled. A disabled or failing event sink must not suppress analytics. Agent events stay metadata. Prompts, diffs, tool payloads, and review checkpoint contents do not enter agent events, logs, or ordinary product events. Publish and specialist stages are also AI spans when a token is set. Specialist stages are emitted as they settle, without waiting for the whole review. Missing latency and usage fields are omitted, never invented as zero. A trace send failure does not change the durable outcome.

- **AI traces.** A non-empty `POSTHOG_PROJECT_TOKEN` makes the process send one AI trace per work run attempt, including credential-redacted prompts, reasoning, and tool payloads. Generations use PostHog's message shape (`role` and `content`, with model tool calls as `function` parts). Tool spans carry bounded input and output plus `input_sha256` and, for `execute`, `code_sha256`. Code Mode `tool:execute` spans list each host call with its input, status, duration, hash, and a bounded output preview (`codemode_host_calls`). Session spans carry loop and stall counters (`repeat_host_calls`, `repeat_top`, `repeat_code_top`, `ms_since_last_activity`, `tool_ms_total`, `model_ms_total`). A cancelled or failed session also carries its last turns, last tool input and output, partial findings, and why it stopped. Cut-off generations keep their streamed text with `partial=true`, failed specialist runs carry `deadline_hit`, and overflow sends metadata-only events instead of dropping them. The execution id is `$ai_trace_id`. The work run id is `$ai_session_id`. An empty token records nothing. Webhook intake does not emit traces. Shutdown drains the trace client inside the same bounded reserve as analytics. Folded provider retries are one generation. Unknown prices are omitted. Query `posthog.ai_events`. See [trace inspection](agent-work-ops.md#posthog-ai-traces).

- **Repeated specialist execute.** The same `execute` result six times for one code ends that specialist's turn and keeps a report already submitted. The other specialists keep running. `repeat_code_top` stays a trace.
- **Cache token telemetry.** `completion`, `failure`, and `usage` lifecycle events carry six numeric detail fields: `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `cacheWrite1hTokens`, and `totalTokens`. They flow from the sanitized event through the telemetry bridge (`src/agent/runtime/durable/telemetryBridge.ts`) into evlog. A PostHog AI generation carries the same six as `$ai_input_tokens`, `$ai_output_tokens`, `$ai_cache_read_tokens`, `$ai_cache_write_tokens`, `$ai_cache_write_1h_tokens`, and `$ai_total_tokens`. Each field is omitted (not zeroed) when the provider did not report it, so a missing key means unknown, not zero. Query per-phase cache reads in PostHog on `$ai_generation` events, grouped by phase.

- **Webhook received.** Webhook intake emits `"webhook received"` with `outcome` in `{accepted, duplicate, rejected}` and a `reason`. Duplicate reasons are `delivery_duplicate` and `body_duplicate`. Rejected reasons include `invalid_signature`, `invalid_json`, `parse_error`, `timeout`, and `handler_failed`. An ignored-but-200 delivery is `accepted`.

- **Prompt cache excellence** — `review_run_completed` includes raw `cacheReadTokens` / `cacheWriteTokens` / optional `cacheWrite1hTokens`, plus derived `cacheHitRate` = `cacheRead / (providerInput + cacheRead + cacheWrite)` and `cacheWriteAmplification` = `cacheWrite / max(cacheRead, 1)`. It also names `cacheBreakSection`, `cacheBreakByte`, and `cacheBreakSession`. `cacheBreakSection` is `shared_prefix`, `role_body`, `tool_definitions`, `history`, or `append_only`. The byte is the first differing UTF-8 offset, and it is null for `append_only` or when the run sent one request. The session is the role of that request. The log keeps the first break that is not `append_only` and does not include prompt text or tool JSON. All four ratio fields are `null` when provider cache usage was never known for the run. High hit rate with low write amplification means the stable system+tools prefix is paying off; high write amplification or null cache fields after a long run usually means provider usage metadata is missing or the prefix is still busting. `cacheReadTokens` is the summed provider total from `usage.cacheRead`. A prefix hit is a sequential probe. One prefixed specialist request returns, then a second specialist with a different body and the same prefix is sent. Judge that second response against two cold write sizes from the same provider and model. One write is `specialistSharedPrefix` alone. The other is a full specialist prompt. `review_run_completed` `cacheHitRate` mixes every role in the run. `dispatch_specialists` starts all four specialist requests before any response returns.
- Structured logging uses [evlog](https://www.evlog.dev) with `service: pr-agent`. `LOG_LEVEL` maps to evlog `minLevel` (default `info`). `LOG_MAX_WIDE_EVENTS` (code constant, default `128`) caps sub-events per webhook or work run operation. `LOG_REDACT` (default true) redacts secret-shaped substrings from logs. `LOG_PRETTY` defaults to off in production (JSON lines).
- Production logging should stay at `info` unless debugging a specific review run (`LOG_LEVEL=debug`).

## Agent session upgrade

Sessions run on `@earendil-works/pi-durable`, `@earendil-works/pi-codemode`, and
`@earendil-works/pi-ai`, pinned to exact 1.6.0 in `dependencies` and
`overrides`. Conversations, the review orchestrator task, and its specialists
persist in `pi_durable.sqlite`, so a restart resumes a review from its
checkpoint instead of starting over. Snapshot env keys are ignored. Capped
submit repairs retain their last validation diagnostic. All `@earendil-works/*`
value imports stay under `src/agent/runtime/durable/`.

## Review reliability rollout

Before each new review execution, a repository-specific App-JWT installation
lookup checks identity, association, suspension, and endpoint permission levels.
Ask, description, triage, and verification load that same policy before they
write, including a cancel that runs before the work is claimed. If that lookup
fails, the work run is still cancelled and the cancel hook does not call GitHub.
Metadata and a required cold mint/refresh share a two-second total deadline,
with transport abort and no request retries or inline throttle wait. No boot
account scan or test mutation is performed. Missing essential PR/code reads or
review/comment publication fails clearly before checkout/model work. Optional
Checks, statuses, Actions, category/size/security labels, and reactions are
disabled only for that run, with one concise review notice when comments are
available. Publication denial keeps a typed durable failure and operator
diagnostic, not a promised GitHub notice.

Timeouts, rate limits, malformed metadata, and ambiguous errors are unknown,
never confirmed missing permissions. `github.preflight_unavailable` retries
within the work run's `QUEUE_RETRY_LIMIT + 1` attempt budget and never spends
model calls or triggers escalation. Exhaustion is `github.preflight_exhausted`,
not permission missing. Shared-circuit deferral probes nothing and spends no
probe count. Confirmed essential denial is `github.essential_access_denied`.

CI source availability is installation-scoped and lives in
`github_repository_capabilities`, without credentials. Denied or incomplete
Checks or legacy statuses cannot produce passing/no-CI claims; known failures
remain with a partial-view notice. Confirmed denials stop self-scheduled
denied-source/write loops. A fresh restored grant forces a listing even on a
previously terminal head. Only a successful complete source read clears
restoration state. Applicable pending verdicts can then repair independently.
Deliberately skipped surfaces are not fake acceptance receipts. Exact summary
receipts are checked before new output admission; optional cleanup cannot
invalidate proven completion.

Review recovery lives in the `reviewOrchestratorTask` checkpoint in
`pi_durable.sqlite`: the brief, the recon pack and its hash, each specialist's
outcome and report, the accepted-findings ledger, and publish progress. Finding
details, fix directions, and suggested code can contain code excerpts. Saved
coverage never grants evidence: finding validation reads the evidence binding
of the request that produced each report. Accepted remote operation receipts in
`publish_records` stay authoritative and are never reopened. PostHog receives
metadata only, never checkpoint contents.

Before downgrading verification, stop the process so no attempt can consume a
new terminal thread-denial state. Setting `FEATURE_VERIFICATION=off` alone does
not stop pending verification work runs. Preserve accepted child effects and
receipts; use a new `/verify` only after understanding the denial. The
two-second budget applies only to installation preflight, not ordinary PR reads
or review execution. Repeatable local integration proves the bounded protocol
and durable recovery, not acceptance by a live GitHub installation.

## One-Time Clean-Break Cutover Runbook

This runs once per deployment, when moving from the last Postgres release to
the single-process SQLite release. Nothing is converted: the new data volume
starts empty, open PRs keep their bot artifacts on GitHub, and the first run on
each open PR rediscovers its standing review, summary comment, and progress
comment from their `operation-intent` markers instead of posting duplicates.
Deliveries that GitHub sends during the freeze are replayed through the GitHub
App Deliveries API.

GitHub keeps webhook deliveries for 3 days. Plan the freeze to last minutes,
well under that retention, so every frozen delivery can still be replayed.

1. **Tag and record.** Tag the deployed Postgres release `v1-postgres` (for
   example `git tag v1-postgres <deployed-sha> && git push origin v1-postgres`).
   Record `freezeStart` as the current UTC time in ISO 8601. Every later filter
   uses it.
2. **Freeze webhook ingress.** Make `/webhooks` answer `503` for every request,
   for example `respond /webhooks 503` in the TLS front, or stop the old web
   service. GitHub records each frozen delivery as failed (`status_code` 503,
   or 0 / 5xx when nothing answers). Leave the old worker running.
3. **Drain the Postgres queue to zero.** On the old deployment, wait until no
   work is left, for example:

   ```sql
   SELECT status, count(*) FROM agent_work_items
    WHERE status IN ('queued', 'running') GROUP BY status;
   SELECT name, state, count(*) FROM pgboss.job
    WHERE state IN ('created', 'retry', 'active') GROUP BY name, state;
   ```

   Both must return no rows. Then stop the old worker and the old database.
   Keep the old Postgres volume untouched; it is the only state the
   `v1-postgres` release can run against.

4. **Deploy the SQLite image, stop-first.** Stop the old stack without deleting
   volumes (`docker compose down`, never `-v`), check out the new release, and
   update `.env`: remove `ROLE`, `DATABASE_URL`, `PR_ACTOR_LEASE_TTL_SECONDS`,
   `PR_ACTOR_LEASE_RENEWAL_INTERVAL_SECONDS`, `QUEUE_EXPIRE_IN_SECONDS`,
   `QUEUE_HEARTBEAT_SECONDS`, `QUEUE_POLLING_INTERVAL_SECONDS`,
   `QUEUE_RETENTION_SECONDS`, `QUEUE_DELETE_AFTER_SECONDS`, and
   `SHUTDOWN_DRAIN_TIMEOUT_SECONDS`, plus the Compose-only `POSTGRES_*`
   variables. Optionally set `SQLITE_DIR`, `SHUTDOWN_GRACE_MS`,
   `PI_DURABLE_RESET_MAX_BYTES`, and `PI_DURABLE_RESET_MAX_AGE_SECONDS`; the
   defaults fit most hosts. Start the single container on its fresh `/data`
   volume with `docker compose up -d --build`. Only one container may ever
   mount that volume.
5. **Verify before reopening.** Against the container directly, not through the
   frozen ingress:
   - `curl -fsS http://127.0.0.1:7224/health` and
     `curl -fsS http://127.0.0.1:7224/ready` both succeed.
   - `PRAGMA synchronous` reads back `2` (FULL) on both databases. Boot refuses
     to continue otherwise, so a healthy `/ready` with no
     `sqlite_pragma_mismatch` or `storage_pragma_mismatch` error in the boot log
     proves it for `app_state.sqlite` and `pi_durable.sqlite`.
   - The sentinel lock holds: `/data` lists `pr-agent.lock.sqlite`, and a
     second process on the same volume fails fast, for example
     `docker compose run --rm --no-deps pr-agent node dist/index.js` exits with
     "Another pr-agent process holds the SQLite writer lock".
6. **Replay the freeze window before opening live `/webhooks`.** With an App
   JWT (signed with the App private key), list deliveries with
   `GET /app/hook/deliveries?per_page=100`, following the cursor in the `Link`
   header until entries are older than `freezeStart`. Select the replay set:

   ```text
   delivered_at >= freezeStart
   && (status_code === 503 || status_code === 0 || status_code >= 500)
   && redelivery !== true
   && no entry with the same guid, redelivery === true, and a 2xx status_code
   ```

   Entries with `redelivery: true` are earlier replay attempts, not originals,
   and an original whose guid already has a successful redelivery is done.
   Redeliveries keep the original `X-GitHub-Delivery` GUID, so the ingress can
   admit exactly the replay set while live traffic stays frozen, for example in
   Caddy:

   ```text
   @replay header_regexp X-GitHub-Delivery ^(<guid-1>|<guid-2>|...)$
   handle @replay {
   	reverse_proxy 127.0.0.1:7224
   }
   respond /webhooks 503
   ```

   Then send `POST /app/hook/deliveries/{id}/attempts` for each selected
   delivery, one at a time, in ascending `delivered_at` order, and wait for each
   to come back `2xx` in the deliveries list before sending the next.
   Intake deduplicates by delivery GUID and body hash, so a replay that already
   landed is a quiet `200`.

7. **Open live `/webhooks`.** Restore the normal ingress route to
   `127.0.0.1:7224`. Run the step 6 selection once more for anything GitHub
   delivered between the replay and the reopen, and replay it the same way.
   Watch `work_runs` drain with the queries in
   [agent-work-ops.md](agent-work-ops.md#inspect-work-run-health).

Rollback is redeploying `v1-postgres` against its untouched Postgres volume
with the old `.env`, using the same freeze, drain, and replay steps in reverse.
Nothing accepted by the SQLite release is carried back.
