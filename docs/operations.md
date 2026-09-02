# Operations and behaviour

Behaviour semantics, deployment detail, and developer scripts for **pr-agent**. For env tunables see [configuration.md](configuration.md). For queue SQL and recovery see [agent-work-ops.md](agent-work-ops.md). Domain terms: [CONTEXT.md](../CONTEXT.md).

## What the service does

- On **`pull_request`** (`opened`, `synchronize`, `reopened`), durable intake runs. On **`opened`**, it enqueues an automated **orchestrated review run** and a **description run** when `FEATURE_REVIEW` or `FEATURE_DESCRIBE` is `auto`. On **`synchronize`**, it enqueues a **verification run** that re-checks open bot inline findings against the new head when `FEATURE_VERIFICATION=auto`, and (when `FEATURE_REVIEW=auto`) it cancels any auto review still in flight and enqueues one deferred-head replacement so the published review matches the new head. **`reopened`** does not auto-enqueue work. Review workers add an acknowledgement 👀 reaction, post a **review progress comment** stub (Recon + four specialist rows from the first post), run the orchestrator and four specialists, publish inline findings in thread batches, and replace the stub with **`## PR Agent Review`** after all specialists resolve. On terminal success the durable runner replaces 👀 with 👍; on terminal failure it replaces 👀 with 👎. Description workers merge generated content into the PR body inside `<!-- PR_AGENT_DESCRIPTION_BEGIN -->` / `<!-- PR_AGENT_DESCRIPTION_END -->` markers under **`## PR Agent Description`**, preserving user-authored text outside those markers, and use the same 👍 / 👎 outcome reactions.
- On **`issue_comment`** and **`pull_request_review_comment`** (`created` only), detects `/help`, `/ask`, `/describe`, `/review`, `/cancel`, `/triage`, and `/verify`. It also promotes allowed `@bot` mentions to ask intake. Workers publish atomic lifecycle reactions (👀 → 👍 / 👎), replies, and reviews after durable intake; the webhook fiber does not perform **PR-surface I/O**.
- Responds **`200`** after **durable intake** commits to Postgres and pg-boss jobs are enqueued (or **`503`** if intake cannot commit; GitHub may redeliver). Reactions, progress comments, reviews, and ask answers run in **`ROLE=worker`** and may appear seconds after the HTTP response. The webhook does not wait for LLM runs to finish.

Architecture: [ADR 0006](adr/0006-durable-agent-work.md).

## Behaviour and semantics

- **Payload boundary:** each subscribed `X-GitHub-Event` type is validated with minimal Valibot shapes before deduplication. Malformed payloads are logged and skipped without inserting durable dedupe rows (so GitHub retries can succeed after fixes or transient issues).
- **Slash commands** are detected on the **first non-empty line** only, and are **case-sensitive** (`/review` works; `/Review` does not). `/ask <question>` answers one question about the PR or a specific diff line (**code anchor**).
- **Webhook deduplication** is durable: `webhook_events.dedupe_key` keeps delivery-ID correlation, while `webhook_event_replays.body_sha256` blocks the same verified body under any delivery ID. Both records use `WEBHOOK_EVENTS_RETENTION_SECONDS` (30 days by default); replay rows cascade when their event row expires. Duplicate deliveries return **`200`** without creating duplicate **agent work items**. Verified, parsed ignored events consume the same replay window; malformed payloads do not.
- **Review superseding:** when a newer automated review is enqueued for the same PR, it supersedes queued auto-reviews and requests cooperative cancellation of an in-flight auto-review. A `synchronize` push does the same from intake: it supersedes queued auto-reviews, requests cancellation of the running one, and enqueues one deferred-head replacement (no replacement when no review is active, so pushes never re-review a finished PR). The running review observes the cancel request through a fast poll (`REVIEW_CANCEL_POLL_INTERVAL_MS`) while specialists run, and stops through the orchestrator's abort path, which aborts and joins every in-flight specialist. Automated **verification** on `synchronize` uses the same supersede pattern for prior verification items. Slash-command reviews are not superseded.
- **Review check-run identity:** the worker binds `PR Agent Review` to the exact repository, head SHA, check name, and requesting work-item external ID. It adopts a remote run only after a proven duplicate-creation error and one exact provider match; ambiguous or incomplete provider state remains unresolved.
- **Stale-head reschedule.** Automatic-review preflight and the publish gate detect a moved PR head. The worker cancels the stale auto or slash run and enqueues one replacement review for the latest head. The replacement takes ownership of the existing **review progress comment**, so its acknowledgement refreshes the stub and later specialist ticks and summary update the same comment. A replacement that also goes stale fails with retry guidance instead of looping.
- **Orchestrated reviews:** the acknowledgement worker posts a queued progress stub (Head/Source, optional Queue `#N of M` wait rank among queued reviews, optional CI) before the review worker claims the item. The review orchestrator then performs reconnaissance and writes one specialist brief. The progress stub shows Recon as Running (specialists Waiting) until that brief is ready, then marks Recon Done and specialists Running. Correctness, security, quality, and tests specialists then run in parallel. Each completed report is judged once and may publish one incremental `COMMENT` review. Specialist ticks use shared status copy (`Waiting`, `Running`, `No findings`, `N findings`, `Failed`); `N findings` counts accepted ledger placements (inline plus summary-only), not inline threads alone. The final summary waits for all specialists. A failed specialist produces partial coverage, a neutral check run, and an error commit status. If all specialists fail, the worker posts a failure notice instead of a summary.
- **GitHub publish recovery:** every non-idempotent review, ask, description, triage, verification, check, status, and label mutation records an operation intent before calling `PrSurface`. A missing response is reconciled against the authoritative `publish_records` row and then an exact hidden operation marker scoped to the work-item instance or provider id. An `outcome_unknown` intent is never blindly retried; automatic retry is allowed only when the provider proves that acceptance did not occur. If exact recovery is unavailable, the worker preserves the publish record and takes the bounded deterministic degradation path, so an accepted mutation is not duplicated.
- **Single active review:** one review may be queued or running per pull request, enforced at execution time by the **PR actor lease** (`pr_actor_leases`; review, description, triage, and verification each hold one lease per PR). A duplicate `/review` is acknowledged but does not create another work item or change the active progress comment. `/review force` is the exception: it cancels the active run first (see below).
- **`/cancel`:** cancels the active review for the PR (auto or slash, queued or running). The acknowledgement worker replaces the **review progress comment** with a short failure-style notice: `Cancelled by @login. Run \`/review\` to try again.` (no Head/Source/CI/Recon/specialist table). No review is active → short reply only.
- **`/review force`:** cancels any queued or running review for the PR (same mechanism as `/cancel`), then queues a fresh review that resolves the latest head at execution time, all in one intake transaction. The acknowledgement worker completes the old run's check run and cancelled notice first, then posts the new run's queued progress stub and a short confirmation reply. With no active review it behaves like plain `/review`.
- **Review close cancel:** when a PR is closed (merged or not), active review work is cancelled and the acknowledgement worker replaces the progress comment with `PR merged.` or `PR closed.` (same short layout, no progress table).
- **Triage close cancel:** when a PR is closed or merged, queued/running `/triage` work is cancelled in the same intake transaction. Running triage stops at its next durable/Pi checkpoint. The writable checkout re-reads PR lifecycle state through `PrSurface` immediately before commit and push; closed or merged state produces a terminal no-push notice and a `-1` acknowledgement, while fork report-only, path, commit, push-or-nothing, and stale-head controls remain unchanged.
- **Review pointer link:** on the second and later orchestrated runs for a PR, the Files-tab pointer links to the existing **review summary comment** when it can be verified. The first completed summary uses plain text only.
- **CI summary:** the progress stub and completed summary include a **CI** gate row for external checks on the PR head (excluding PR Agent’s own check). Ack uses a lightweight non-LLM snapshot. At publish, the worker waits/polls (`REVIEW_CI_SUMMARY_WAIT_*`), selects one condensed, redacted, size-bounded CI context when CI is red (Actions job logs, or check output if logs are unavailable), and runs a small LLM turn to author `headline` / failure `reason`+`fixHint` (server still owns status facts and HTML rendering). If CI is still pending at publish, the row stays pending; a later `workflow_run` or `check_suite` **completed** webhook enqueues a CI-refresh job that edits only the CI cell on the matching **review summary comment** for that head SHA (no full re-review). Missing **Checks: Read** shows a grant-Checks row; missing **Actions: Read** on a failing head keeps the failure row and adds a grant-Actions note. The review still publishes either way. Caps: `REVIEW_CI_SUMMARY_*` in `reviewConstants.ts`. See [ADR 0018](adr/0018-llm-authored-ci-summary.md).
- **Review map link:** the summary links to the PR description's **review map** only when that section was published (read-first map mode). Short omit-mode descriptions have no map and no summary link.
- **Worker concurrency:** review, ask, acknowledgement, CI-refresh, description, triage, and verification jobs are capped per process by **`REVIEW_CONCURRENCY`** (default `2`), **`ASK_CONCURRENCY`** (default `1`), **`ACK_CONCURRENCY`** (default `2`, also used for `agent-work-ci-refresh`), **`DESCRIPTION_CONCURRENCY`** (default `1`), **`TRIAGE_CONCURRENCY`** (default `1`), and **`VERIFICATION_CONCURRENCY`** (default `1`) via pg-boss worker `localConcurrency` ([`src/agentWork/worker.ts`](../src/agentWork/worker.ts)). Multi-replica deployments remain at-least-once at the worker layer. **Effective cluster admission** for a queue is approximately `replicas × localConcurrency` (plus `INSTALLATION_GROUP_CONCURRENCY` for group-scoped lanes).
- **GitHub rate-limit circuit (per run + shared MVP):** after three consecutive primary/secondary rate-limit retries are exhausted inside a review/ask run, nonessential GitHub tools short-circuit for the rest of that run; a successful GitHub request resets the consecutive-failure counter. Emits `github_rate_limit_circuit_opened` logs and `rate_limit_circuit_opened` review metrics. Opening a local circuit also upserts a **Postgres shared circuit** keyed by `installation_id` (`github_installation_rate_limit_circuits`: `open_until`, `last_error_kind`, default cooldown `SHARED_RATE_LIMIT_CIRCUIT_COOLDOWN_MS` = 60s). Other workers check that row at review/ask start and hydrate their local circuit open (`github_shared_rate_limit_circuit_honored`) so replicas do not immediately re-burst the same installation. Full Redis Bottleneck clustering remains optional ([ADR 0004](adr/0004-github-api-rate-limits.md)).
- **Tool surface:** production review and ask agents use the local workspace tools `listChangedFiles`, `readWorkspaceFile`, `searchWorkspace`, `getWorkspaceDiff`, `getWorkspaceBlame`, and `resolveSymbol` (ephemeral per-run symbol index). When `CODE_INDEX_MODE=fts`, reviews also expose `searchCodeIndex` (Postgres FTS navigation hints only — `readWorkspaceFile` remains mandatory before citing). Plus two Context7 tools. The review orchestrator hands off through `submit_specialist_brief`, judges reports with `publish_thread`, and finishes through `publish_summary`. Specialists submit one `submit_findings_report`. GitHub reads and writes remain server-owned. See [ADR 0011](adr/0011-agent-runner-local-pr-workspace.md), [ADR 0012](adr/0012-full-context-local-pr-workspace.md), and [ADR 0002](adr/0002-context7-docs-tool.md).
- **Library docs lookup:** review and ask agents get Context7 tools (`resolveLibraryId`, `getLibraryDocs`) that use the fixed `https://context7.com/api` endpoint. The shared outbound policy validates library identifiers, trims and bounds query/topic text, redacts secret-shaped responses, and rejects URLs, multiline/prompt/comment/source/tool-output content before URL construction. **`CONTEXT7_API_KEY`** is optional and is sent only as `Authorization: Bearer ...`; empty keys use anonymous fallback. See [ADR 0002](adr/0002-context7-docs-tool.md).
- **Pi-native agent runtime:** Set **`PI_PROVIDER`/`PI_MODEL`** for general sessions, optional **`PI_ORCHESTRATOR_*`** and **`PI_FALLBACK_*`**, and an optional **`models.json`** catalog. See [ADR 0023](adr/0023-pi-native-agent-runtime.md).
- **Bot identity** for self-suppression is cached per **`GITHUB_APP_ID`**, so multiple GitHub Apps in one process do not share the same cache entry.
- **`WEBHOOK_TIMEOUT_MS`** (code constant, default `10000`) is the webhook intake response budget. Intake that exceeds this budget minus `GITHUB_WEBHOOK_RESPONSE_MARGIN_MS` returns **`503`** before GitHub reports a delivery timeout. Worker jobs are still supervised separately.
- **`/triage`:** trigger-only autofix work type. Post `/triage` on the PR conversation to triage unresolved findings from current specialist runs and recognized legacy lens threads. Reply `/triage` inside a bot inline finding thread to scope the run to that finding. Triage skips fork PR pushes, fixes same-repo findings in an isolated writable checkout, commits with validated messages, and pushes without force. A `dismissed` verdict requires an authorized non-bot maintainer decision from `MAINTAINER_DECISION_ASSOCIATIONS` on the matching finding thread; ordinary, missing-metadata, and bot replies remain untrusted evidence. After a successful push, it replies on `fixed` threads then resolves them. It resolves `already-resolved` and `dismissed` threads even when push is stale or there were no commits (`skipped` stays open). It upserts **`## PR Agent Triage`**. Fix commits use the human `/triage` issuer as git author and committer (profile or id-based noreply email) with a GitHub App `Co-authored-by` trailer; bot/app or unresolvable issuers keep App authorship without a redundant App co-author. Push still uses the installation token (App). The bot push triggers a normal `synchronize` verification run. Close/merge cancellation is terminal and no-push, including when the branch remains available. The writable workspace `searchWorkspace` may grep the checkout internally, but normalizes each result and applies the canonical sensitive/control-path policy to the path and its resolved symlink target before returning the path or matching text. Blocked matches are omitted and reported only with a non-sensitive filtered indicator; literal-query, timeout, result-cap, and output-budget behavior remains unchanged. GitHub App needs **Contents: read/write** for this command.
- **Verification runs:** auto-triggered on `pull_request` `synchronize` when `FEATURE_VERIFICATION=auto` (the default), or on demand with `/verify` when the feature is `manual` or `auto` (`off` disables both). Read-only: re-checks open bot inline findings against the current head. **Fixed** and **already-resolved** threads are resolved without a new reply; if a prior verification stub exists, it is edited in place to a short fixed/already-resolved line so a stale still-open signal is not left behind. **Still-open** findings on files changed in the push update one verification stub comment in place. **Dismissed** findings require an authorized non-bot maintainer decision from `MAINTAINER_DECISION_ASSOCIATIONS` on the matching finding thread; other reply text is untrusted evidence. Verification edits that stub (evidence + policy suggestion) and then resolves the thread. No ack reaction, progress comment, or summary comment is posted.
- **Policy suggestions for dismissed findings:** when triage or verification dismisses a finding, the bot drafts a paste-ready `.pr-agent/*.mdc` suggestion. Verification grounds the suggestion in the checkout’s existing rules when exactly one rule matches the finding path (append fragment); otherwise it proposes a new `.mdc` starter. Triage always proposes a new `.mdc` starter.
- **`/ask` and `@bot` mentions:** interactive Q&A about PR code (and conversational follow-ups in the same thread). Shared intake admits work through durable actor, repository, and installation token buckets plus outstanding limits before inserting `agent_work_items`. When configured, the installation provider budget reserves a bounded token amount; exact Pi usage reconciles it and unknown usage consumes the reservation. Excess asks receive one static throttling reply and do not enter `agent-work-ask`. The ask queue remains separate from review and triage queues. `@`-mention of the app bot (same allowlist as slash commands) on the PR conversation or an inline review thread also enqueues an ask; the worker loads the containing thread transcript into the prompt. Explain-only — no severity/dismiss mutations. See [ADR 0005](adr/0005-ask-command.md).
- **Lightweight review completion:** automated reviews on docs-only trivial PRs may finish without an **orchestrated review run** under the **trivial change exemption**. See [ADR 0010](adr/0010-lightweight-review-completion.md).

## Large PRs and GitHub rate limits

- **`@octokit/plugin-throttling`** paces all installation-token REST calls (review tools, publish, reactions). File listing and patch caps are code constants in `src/settings/reviewConstants.ts`: `MAX_PR_FILES_LISTED` (default `300`), `MAX_PR_FILES_PATCH_BYTES` (default `500000`).
- Throttle hooks log `octokit_on_rate_limit` / `octokit_on_secondary_rate_limit`. Circuit open logs `github_rate_limit_circuit_opened`. Capture a redacted sample when debugging production limits.
- See [ADR 0004](adr/0004-github-api-rate-limits.md) for policy (secondary-limit retries and truncation trade-offs).

## Deployment

### Docker and Docker Compose

- **Stack:** [docker-compose.yml](../docker-compose.yml) runs **`postgres`**, **`pr-agent-web`** (`ROLE=web`), and **`pr-agent-worker`** (`ROLE=worker`). `docker compose up` is required for end-to-end reviews and asks; web-only is not sufficient.
- **Image:** multi-stage `Dockerfile` (Node 22); runtime listens on **`PORT`** (pinned to **7224** in Compose and [`.env.example`](../.env.example)).
- **Health (web):** `GET /health` returns `200` and plain `ok`. `GET /ready` runs a Postgres `SELECT 1` and returns `503` when the database is unreachable (orchestrator readiness gating).
- **Health (worker):** the worker listens on `PORT` for the same paths. `GET /health` is process liveness. `GET /ready` requires registered queue consumers plus Postgres/pg-boss access (idle empty queues still ready). Compose wires the worker healthcheck to `/ready`. Continuous queue/DLQ diagnostics emit every 60s; see [agent-work-ops.md](agent-work-ops.md).
- **Webhook URL** (default Compose ports): `http://<host>:7224/webhooks`.
- **`DATABASE_URL`** in Compose: `postgres://pr_agent:pr_agent@postgres:5432/pr_agent`.
- **Provider API keys** (for example **`OPENAI_API_KEY`**, **`ANTHROPIC_API_KEY`**, **`GOOGLE_GENERATIVE_AI_API_KEY`**) are loaded by [`src/config.ts`](../src/config.ts) into `modelProviderKeys`. Set them in `.env` beside the GitHub fields or reviews fail at runtime in the worker.
- **Custom Pi providers (`models.json`):** three ways to get a catalog into the container at `/app/models.json` (process cwd), or elsewhere via **`MODELS_JSON_PATH`**:
  1. **Build-context copy (default image behavior):** if repo-root `models.json` is present when you `docker build`, the runtime stage copies it to `/app/models.json`. If the file is absent, the build still succeeds (built-ins only). Dokploy **Patches** can `create` File Path `models.json` after clone and before build — no `MODELS_JSON_PATH` and no Dockerfile edit required when using the image cwd.
  2. **Runtime bind mount:** copy [`models.json.example`](../models.json.example) to a host file, then mount it into **both** web and worker. Create the host file **before** mounting — Docker turns a missing host path into a directory.
  3. **`MODELS_JSON_PATH`:** mount the catalog anywhere and point the env var at that path.

  Example Compose fragment for a host mount:

  ```yaml
  services:
    pr-agent-web:
      volumes:
        - ./models.json:/app/models.json:ro
    pr-agent-worker:
      volumes:
        - ./models.json:/app/models.json:ro
  ```

- **Secrets:** never commit `.env`; keep Compose files off public pastebins.

```bash
cp .env.example .env
docker compose build
docker compose up
```

Compose sets `environment.PORT=7224` and **`7224:7224`** publishing. For a host port clash, change **`ports`** to for example **`7227:7224`** and keep container **`PORT`** at **7224**.

**Requires Docker Engine with Compose v2.** `env_file` defaults to **`.env`**; use host env **`PR_AGENT_ENV_FILE`** for an alternate path.

The Compose `postgres` service sets `shm_size: 128mb` and conservative server tuning flags (`shared_buffers`, `effective_cache_size`, `maintenance_work_mem`, `wal_compression`, `random_page_cost`). Override them with the `POSTGRES_SHARED_BUFFERS`, `POSTGRES_EFFECTIVE_CACHE_SIZE`, `POSTGRES_MAINTENANCE_WORK_MEM`, `POSTGRES_WAL_COMPRESSION`, and `POSTGRES_RANDOM_PAGE_COST` Compose env vars. The base Compose file owns `shm_size` and those tuning flags; the production overlay only requires credentials via `:?` env vars.

```bash
PR_AGENT_ENV_FILE=/abs/path/to/.env docker compose up
```

### Runtime (Effect TS)

- Production boot uses a **web/worker split** (`ROLE` env).
- **Web:** [`processWebhookRequestEffect`](../src/effect/programs/processWebhookRequestEffect.ts) verifies signatures, parses payloads, and dispatches to [`WebhookHandlers`](../src/effect/services/webhookHandlers.ts), which call [`AgentWorkScheduler`](../src/agentWork/scheduler.ts) for Postgres intake and pg-boss enqueue.
- **Worker:** [`agentWorkWorkerLive`](../src/agentWork/workerRuntime.ts) consumes acknowledgement, review, ask, description, triage, verification, and CI-refresh queues; PR-surface I/O and LLM runs happen via [`executors/`](../src/agentWork/executors/).
- **PR actor lease cutover (one-time):** the release that introduces `pr_actor_leases` ([ADR 0030](adr/0030-pr-actor-lease.md)) changes the review, description, triage, and verification queues from `key_strict_fifo` to `standard`. Drain old workers before starting new ones: stop `pr-agent-worker`, let in-flight jobs finish or expire, then deploy. Migration 023 flips the policy on existing queue rows (pg-boss never changes a policy itself), and boot logs `agent_queue_policy_mismatch` if any leased queue was not flipped. Mixed old/new workers are still unsafe — old workers fence on per-job queue policy while new workers fence on the lease — so the drain is required even though the flip is automatic. There is nothing to backfill.

### Local development edge cases

- **`nub src/index.ts` loads `.env` automatically** for local development. `nub watch src/index.ts` restarts on source, tsconfig, and env changes.
- **`GITHUB_APP_PRIVATE_KEY` must be a valid PEM key**. For local-only dev: `openssl genrsa 2048 > key.pem` and set the escaped PEM in `.env`.
- Tunnel webhooks (e.g. [smee.io](https://smee.io)) to local `PORT`, then point the GitHub App webhook at the smee URL forwarding to `/webhooks`.
- If switching from a prior pnpm- or npm-installed tree, delete `node_modules` before the first `nub install`.
- **Vercel** site deploys install pinned Nub in [`site/vercel.json`](../site/vercel.json) (`npm install -g @nubjs/nub@…` + `nub ci`), then build with `nub run build`. The site serves a dense agent profile at `/llms.txt` plus queryable `GET /llms?query=` and `GET /llms/json?query=` from [`site/lib/llmsKnowledge.ts`](../site/lib/llmsKnowledge.ts).
- **Docker image** installs with Nub only (`nub ci` for build deps; `nub prune --prod` for the runtime tree). No `corepack` / `pnpm deploy` in the Dockerfile. [`.dockerignore`](../.dockerignore) keeps `site/package.json` in the build context so the workspace lockfile stays valid under frozen installs; the rest of `site/` stays excluded.

Canonical quick start steps live in [README.md](../README.md) **Host with Docker Compose**.

## Development

### Scripts

| Script                                 | Purpose                                                                 |
| -------------------------------------- | ----------------------------------------------------------------------- |
| `nub src/index.ts` / `nub run dev`     | Run `src/index.ts` (`ROLE` env)                                         |
| `nub watch src/index.ts`               | Auto-restart dev entry                                                  |
| `nub run build`                        | Compile to `dist/`                                                      |
| `nub run start` / `node dist/index.js` | Run compiled `dist/`                                                    |
| `nub run typecheck`                    | `tsc --noEmit` (`src/` only)                                            |
| `nub run lint`                         | Type-aware Oxlint (includes `site/`)                                    |
| `nub run lint:backend`                 | Type-aware Oxlint excluding `site/`                                     |
| `nub run lint:fix`                     | Oxlint with safe fixes                                                  |
| `nub run fmt`                          | Format with Oxfmt                                                       |
| `nub run fmt:check`                    | Check formatting                                                        |
| `nub run check:code`                   | `typecheck` + `lint` + `fmt:check`                                      |
| `nub run check:effect-versions`        | Verify pinned Effect deps                                               |
| `nub run check:prod-deps`              | Production dependency graph guard                                       |
| `nub run test`                         | Vitest (`test/**/*.test.ts`)                                            |
| `nub run test:watch`                   | Vitest watch mode                                                       |
| `nub run test:integration`             | Vitest integration suite (requires Postgres; fails fast if unreachable) |
| `nub run test:integration:inventory`   | Same suite, but may skip DB cases when `DATABASE_URL` is unset          |
| `nub run --node test`                  | Vitest via plain Node (escape hatch)                                    |
| `nub run site:dev`                     | Landing site local dev (`pr-agent-landing`)                             |
| `nub run site:build`                   | Landing site production build                                           |
| `nub run site:generate-og`             | Generate landing OG assets                                              |

Type awareness comes from [`.oxlintrc.json`](../.oxlintrc.json) `options.typeAware` (lint scripts do not pass `--type-aware`). Keep `nub run typecheck` as separate `tsc`. Type-aware lint requires `oxlint-tsgolint` (dev dependency). Registry cooling-window settings live only in [`nub.jsonc`](../nub.jsonc) (`install.minimumReleaseAge`, `install.minimumReleaseAgeExclude`); edit that file when adding or removing temporary excludes.

### Effect version gate

`nub run check:effect-versions` enforces pinned versions:

- `effect@3.22.0`
- `@effect/platform@0.97.0`
- `@effect/platform-node@0.108.0`

`nub run test` runs this gate before Vitest (`pretest`).

Agent index: [AGENTS.md](../AGENTS.md).

## Security

- Treat `WEBHOOK_SECRET` and app private keys as production secrets.
- **`/ask`** applies deterministic outbound redaction (tokens, host URLs, PEM blocks) before posting replies; obvious bot-internals probes get an **Ask meta refusal** without an LLM call ([ADR 0007](adr/0007-ask-red-team-hardening.md)).
- **Triage workspace boundary:** direct reads, search results, edits, staging, and commits use the canonical triage sensitive/control-path policy. Search may inspect the checkout internally, but it never returns a blocked path or its matching text; symlink targets are resolved before the decision.
- **Triage report comments** run through the same public-output redactor before upsert to GitHub (normal and report-only paths).
- **Telemetry redaction** uses one canonical recursive sanitizer at logging and analytics boundaries (`src/security/sanitizeTelemetryValue.ts`). It handles `AppError` messages, contexts, raw values, causes, arrays, objects, Error fields, and circular references across camel- and snake-case payloads. Secret-shaped strings and sensitive keys are replaced while safe codes, classifications, work IDs, provider kinds, and resource identifiers remain available. PostHog is optional: enabled only when `POSTHOG_PROJECT_TOKEN` is non-empty and sink construction succeeds (`src/analytics` facade; empty token means no SDK load). Failed construction or reinitialization restores a no-op sink with analytics disabled; the PostHog `before_send` sanitizer is the final recursive backstop for explicit and autocaptured exceptions ([ADR 0007](adr/0007-ask-red-team-hardening.md)).
- **Classified external failures** — Terminal and soft-fail agent-work events carry `failure_domain` (`provider` | `github` | `internal` | `unknown`), `error_kind` (provider: `auth`/`quota`/`billing`/`rate_limit`/`timeout`; GitHub: `auth`/`forbidden`/`not_found`/`validation`/`rate_limit`; plus `validation`/`publish`/`cancelled`/`superseded`/`unknown`), and sanitized `error_message`. Query these on `work item failed`, `ask failed`, `description failed`, `triage failed`, and `verification failed`. Durable `"work item failed"` also keeps `provider_error_kind` when `failure_domain === "provider"`. Superseded/cancelled/stale-head runs use `failure_domain=internal` with `error_kind` in `{superseded,cancelled}` — never provider. Matching evlog fields use camelCase (`failureDomain`, `errorKind`, `errorMessage`) on `review_not_published`, `agent_publish_fallback`, `agent_work_failed`, and siblings. Classification is logs/analytics only. PR-facing failure notices stay neutral.
- **Review profile.** Each executed review sends one `"review profiled"` event. A review that throws after claim also sends this event. The analytics facade sends the event. The distinct ID is the installation.

  The `outcome` property is `published`, `failed`, `degraded`, `superseded`, or `lightweight`. The event includes `work_item_id` and `attempt_count`. The event includes `queue_ms`, `review_ms`, and `total_ms`. `queue_ms` is claim start minus create time. `review_ms` is finish minus claim start. `total_ms` is finish minus create time.

  The event also includes provider, model, phase, token, cache, tool, finding, and publish fields. These fields come from `ReviewRunMetricsSnapshot`. A failed outcome adds `failure_domain` and `error_kind`. A provider failure also adds `provider_error_kind`. The event adds `phase` only when the phase is a known safe value. The event omits `error_message` and the thrown message. The event omits prompts, source, model text, tool payloads, paths, hashes, and URLs.

  The event includes `wall_clock_ms`, `provider_output_tokens`, and `generation_ms`. When `generation_ms` is greater than 0, the event includes `provider_output_tps`. `provider_output_tps` equals tokens divided by generation seconds. The event also includes `token_coverage`. Use these fields to separate slow generation from failures. Degraded runs show `outcome=degraded`, extra publish attempts, or tool errors. Do not treat wall-clock alone as provider TPS. A suggested dashboard gate is `wall_clock_ms >= 180000`. Treat the run as provider-TPS-slow when TPS is under 10 without a retry signal.

  A later check-run or cleanup failure does not send a second event. Durable `"work item failed"` and `captureException` stay on the durable-work path. An empty `POSTHOG_PROJECT_TOKEN` keeps capture as a no-op.

- **Prompt cache excellence** — `review_run_completed` includes raw `cacheReadTokens` / `cacheWriteTokens` / optional `cacheWrite1hTokens`, plus derived `cacheHitRate` = `cacheRead / (providerInput + cacheRead + cacheWrite)` and `cacheWriteAmplification` = `cacheWrite / max(cacheRead, 1)`. All four ratio fields are `null` when provider cache usage was never known for the run. High hit rate with low write amplification means the stable system+tools prefix is paying off; high write amplification or null cache fields after a long run usually means provider usage metadata is missing or the prefix is still busting. Policy: [ADR 0025](adr/0025-prompt-cache-stability.md).
- Structured logging uses [evlog](https://www.evlog.dev) with `service: pr-agent`. `LOG_LEVEL` maps to evlog `minLevel` (default `info`). `LOG_MAX_WIDE_EVENTS` (code constant, default `128`) caps sub-events per webhook/worker operation. `LOG_REDACT` (default true) redacts secret-shaped substrings from logs. `LOG_PRETTY` defaults to off in production (JSON lines).
- Production logging should stay at `info` unless debugging a specific review run (`LOG_LEVEL=debug`).
