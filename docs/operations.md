# Operations and behaviour

Behaviour semantics, deployment detail, and developer scripts for **pr-agent**. For env tunables see [configuration.md](configuration.md). For queue SQL and recovery see [agent-work-ops.md](agent-work-ops.md). Domain terms: [CONTEXT.md](../CONTEXT.md).

## What the service does

- On **`pull_request`** (`opened`, `synchronize`, `reopened`), durable intake runs. On **`opened`**, it enqueues an automated **orchestrated review run** and a **description run** when `FEATURE_REVIEW` or `FEATURE_DESCRIBE` is `auto`. On **`synchronize`**, it enqueues a **verification run** that re-checks open bot inline findings against the new head when `FEATURE_VERIFICATION=auto`. **`reopened`** does not auto-enqueue work. Review workers add an acknowledgement 👀 reaction, post a **review progress comment** stub (Recon + four specialist rows from the first post), run the orchestrator and four specialists, publish inline findings in thread batches, and replace the stub with **`## PR Agent Review`** after all specialists resolve. On terminal success the durable runner replaces 👀 with 👍; on terminal failure it replaces 👀 with 👎. Description workers merge generated content into the PR body under **`## PR Agent Description`**, preserving user-authored text above that header, and use the same 👍 / 👎 outcome reactions.
- On **`issue_comment`** and **`pull_request_review_comment`** (`created` only), detects `/help`, `/ask`, `/describe`, `/review`, and `/triage`. It also promotes allowed `@bot` mentions to ask intake. Workers publish atomic lifecycle reactions (👀 → 👍 / 👎), replies, and reviews after durable intake; the webhook fiber does not perform **PR-surface I/O**.
- Responds **`200`** after **durable intake** commits to Postgres and pg-boss jobs are enqueued (or **`503`** if intake cannot commit; GitHub may redeliver). Reactions, progress comments, reviews, and ask answers run in **`ROLE=worker`** and may appear seconds after the HTTP response. The webhook does not wait for LLM runs to finish.

Architecture: [ADR 0009](adr/0009-durable-agent-work.md).

## Behaviour and semantics

- **Payload boundary:** each subscribed `X-GitHub-Event` type is validated with minimal Zod shapes before deduplication. Malformed payloads are logged and skipped without inserting a dedupe row (so GitHub retries can succeed after fixes or transient issues).
- **Slash commands** are detected on the **first non-empty line** only, and are **case-sensitive** (`/review` works; `/Review` does not). `/ask <question>` answers one question about the PR or a specific diff line (**code anchor**).
- **Webhook deduplication** is durable: `webhook_events.dedupe_key` uses `X-GitHub-Delivery` when present, otherwise SHA-256(raw body). Duplicate deliveries return **`200`** without creating duplicate **agent work items**.
- **Review superseding:** when a newer automated review is enqueued for the same PR, it supersedes queued auto-reviews and requests cooperative cancellation of an in-flight auto-review. Automated **verification** on `synchronize` uses the same pattern for prior verification items. Slash-command reviews are not superseded.
- **Stale-head reschedule:** when an in-flight auto or slash review reaches publish after the PR head moved, the worker cancels that run and enqueues one replacement review for the latest head. A replacement that also goes stale fails with retry guidance instead of looping.
- **Orchestrated reviews:** the review orchestrator performs reconnaissance and writes one specialist brief. The progress stub shows Recon as Running (specialists Waiting) until that brief is ready, then marks Recon Done and specialists Running. Correctness, security, quality, and tests specialists then run in parallel. Each completed report is judged once and may publish one incremental `COMMENT` review. Specialist ticks use shared status copy (`Waiting`, `Running`, `No findings`, `N findings`, `Failed`). The final summary waits for all specialists. A failed specialist produces partial coverage, a neutral check run, and an error commit status. If all specialists fail, the worker posts a failure notice instead of a summary.
- **Single active review:** one review may be queued or running per pull request. A duplicate `/review` is acknowledged but does not create another work item or change the active progress comment.
- **Review pointer link:** on the second and later orchestrated runs for a PR, the Files-tab pointer links to the existing **review summary comment** when it can be verified. The first completed summary uses plain text only.
- **CI summary:** the progress stub and completed summary include a **CI** gate row for external checks on the PR head (excluding PR Agent’s own check). Ack uses a lightweight non-LLM snapshot. At publish, the worker waits/polls (`REVIEW_CI_SUMMARY_WAIT_*`), downloads condensed Actions job logs when CI is red, and runs a small LLM turn to author `headline` / failure `reason`+`fixHint` (server still owns status facts and HTML rendering). If CI is still pending at publish, the row stays pending; a later `workflow_run` **completed** webhook enqueues a CI-refresh job that edits only the CI cell on the matching **review summary comment** for that head SHA (no full re-review). Missing **Checks: Read** shows a grant-Checks row; missing **Actions: Read** on a failing head keeps the failure row and adds a grant-Actions note. The review still publishes either way. Caps: `REVIEW_CI_SUMMARY_*` in `reviewConstants.ts`. See [ADR 0026](adr/0026-llm-authored-ci-summary.md).
- **File walkthrough link:** the summary's per-file +/- walkthrough table is replaced by a link to the PR description's File Walkthrough when a Description agent block exists.
- **Worker concurrency:** review, ask, acknowledgement, CI-refresh, description, triage, and verification jobs are capped per process by **`REVIEW_CONCURRENCY`** (default `2`), **`ASK_CONCURRENCY`** (default `1`), **`ACK_CONCURRENCY`** (default `2`, also used for `agent-work-ci-refresh`), **`DESCRIPTION_CONCURRENCY`** (default `1`), **`TRIAGE_CONCURRENCY`** (default `1`), and **`VERIFICATION_CONCURRENCY`** (default `1`) via pg-boss worker `localConcurrency` ([`src/agentWork/worker.ts`](../src/agentWork/worker.ts)). Multi-replica deployments remain at-least-once at the worker layer. **Effective cluster admission** for a queue is approximately `replicas × localConcurrency` (plus `INSTALLATION_GROUP_CONCURRENCY` for group-scoped lanes). There is no cross-process GitHub rate-limit coordinator yet ([ADR 0007](adr/0007-github-api-rate-limits.md)); each run still opens its own rate-limit circuit after three consecutive classified failures.
- **GitHub rate-limit circuit (per run):** after three consecutive primary/secondary rate-limit retries are exhausted inside a review/ask run, nonessential GitHub tools short-circuit for the rest of that run; a successful GitHub request resets the consecutive-failure counter. Emits `github_rate_limit_circuit_opened` logs and `rate_limit_circuit_opened` review metrics.
- **Tool surface:** production review and ask agents use the local workspace tools `listChangedFiles`, `readWorkspaceFile`, `searchWorkspace`, `getWorkspaceDiff`, and `getWorkspaceBlame`, plus two Context7 tools. The review orchestrator hands off through `submit_specialist_brief`, judges reports with `publish_thread`, and finishes through `publish_summary`. Specialists submit one `submit_findings_report`. GitHub reads and writes remain server-owned. See [ADR 0004](adr/0004-native-pi-ai-toolset.md).
- **Library docs lookup:** review and ask agents get Context7 tools (`resolveLibraryId`, `getLibraryDocs`) that hit `https://context7.com/api`. Set **`CONTEXT7_API_KEY`** for higher limits and private repos. See [ADR 0003](adr/0003-context7-docs-tool.md).
- **Pi-native agent runtime:** Set **`PI_PROVIDER`/`PI_MODEL`** for general sessions, optional **`PI_ORCHESTRATOR_*`** and **`PI_FALLBACK_*`**, and an optional **`models.json`** catalog. See [ADR 0031](adr/0031-pi-native-agent-runtime.md).
- **Bot identity** for self-suppression is cached per **`GITHUB_APP_ID`**, so multiple GitHub Apps in one process do not share the same cache entry.
- **`WEBHOOK_TIMEOUT_MS`** (code constant, default `10000`) is the webhook intake response budget. Intake that exceeds this budget minus `GITHUB_WEBHOOK_RESPONSE_MARGIN_MS` returns **`503`** before GitHub reports a delivery timeout. Worker jobs are still supervised separately.
- **`/triage`:** trigger-only autofix work type. Post `/triage` on the PR conversation to triage unresolved findings from current specialist runs and recognized legacy lens threads. Reply `/triage` inside a bot inline finding thread to scope the run to that finding. Triage skips fork PR pushes, fixes same-repo findings in an isolated writable checkout, commits with validated messages, pushes without force, replies or resolves only after push succeeds, and upserts **`## PR Agent Triage`**. The bot push triggers a normal `synchronize` verification run. GitHub App needs **Contents: read/write** for this command.
- **Verification runs:** auto-triggered on `pull_request` `synchronize` (`FEATURE_VERIFICATION=auto`, the default; `off` disables). Read-only: re-checks open bot inline findings against the new head. **Fixed** and **already-resolved** threads are resolved without a new reply; if a prior verification stub exists, it is edited in place to a short fixed/already-resolved line so a stale still-open signal is not left behind. **Still-open** findings on files changed in the push update one verification stub comment in place. **Dismissed** findings edit that stub (evidence + policy suggestion) and then resolve the thread. No ack reaction, progress comment, or summary comment is posted.
- **Policy suggestions for dismissed findings:** when triage or verification dismisses a finding, the bot drafts a paste-ready `.pr-agent/*.mdc` suggestion. Verification grounds the suggestion in the checkout’s existing rules when exactly one rule matches the finding path (append fragment); otherwise it proposes a new `.mdc` starter. Triage always proposes a new `.mdc` starter.
- **`/ask` and `@bot` mentions:** interactive Q&A about PR code (and conversational follow-ups in the same thread). Runs on the **`agent-work-ask`** pg-boss queue. `@`-mention of the app bot (same allowlist as slash commands) on the PR conversation or an inline review thread also enqueues an ask; the worker loads the containing thread transcript into the prompt. Explain-only — no severity/dismiss mutations. See [ADR 0008](adr/0008-ask-command.md).
- **Lightweight review completion:** automated reviews on docs-only trivial PRs may finish without an **orchestrated review run** under the **trivial change exemption**. See [ADR 0014](adr/0014-lightweight-review-completion.md).

## Large PRs and GitHub rate limits

- **`@octokit/plugin-throttling`** paces all installation-token REST calls (review tools, publish, reactions). File listing and patch caps are code constants in `src/settings/reviewConstants.ts`: `MAX_PR_FILES_LISTED` (default `300`), `MAX_PR_FILES_PATCH_BYTES` (default `500000`).
- On tool failures, logs emit `github_tool_request_error` with `x-github-request-id`, `x-ratelimit-*`, and a classification. Capture a redacted sample when debugging production limits.
- See [ADR 0007](adr/0007-github-api-rate-limits.md) for policy (secondary-limit retries and truncation trade-offs).

## Deployment

### Docker and Docker Compose

- **Stack:** [docker-compose.yml](../docker-compose.yml) runs **`postgres`**, **`pr-agent-web`** (`ROLE=web`), and **`pr-agent-worker`** (`ROLE=worker`). `docker compose up` is required for end-to-end reviews and asks; web-only is not sufficient.
- **Image:** multi-stage `Dockerfile` (Node 22); runtime listens on **`PORT`** (pinned to **7224** in Compose and [`.env.example`](../.env.example)).
- **Health (web):** `GET /health` returns `200` and plain `ok`. `GET /ready` runs a Postgres `SELECT 1` and returns `503` when the database is unreachable (orchestrator readiness gating).
- **Health (worker):** the worker listens on `PORT` for the same paths. `GET /health` is process liveness. `GET /ready` requires registered queue consumers plus Postgres/pg-boss access (idle empty queues still ready). Compose wires the worker healthcheck to `/ready`. Continuous queue/DLQ/blocked-key diagnostics emit every 60s; see [agent-work-ops.md](agent-work-ops.md).
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
- **Worker:** [`agentWorkWorkerLive`](../src/agentWork/runtime.ts) consumes acknowledgement, review, ask, description, triage, verification, and CI-refresh queues; PR-surface I/O and LLM runs happen via [`executors/`](../src/agentWork/executors/).

### Local development edge cases

- **`nub src/index.ts` loads `.env` automatically** for local development. `nub watch src/index.ts` restarts on source, tsconfig, and env changes.
- **`GITHUB_APP_PRIVATE_KEY` must be a valid PEM key**. For local-only dev: `openssl genrsa 2048 > key.pem` and set the escaped PEM in `.env`.
- Tunnel webhooks (e.g. [smee.io](https://smee.io)) to local `PORT`, then point the GitHub App webhook at the smee URL forwarding to `/webhooks`.
- If switching from pnpm-installed trees, delete `node_modules` before the first `nub install`.
- **Vercel** site deploys keep the platform installer (pnpm via [`site/vercel.json`](../site/vercel.json)). Add `@nubjs/nub` as a devDependency only if site scripts need the `nub` binary.
- **Docker image** installs with Nub only (`nub ci` for build deps; `nub prune --prod` for the runtime tree). No `corepack` / `pnpm deploy` in the Dockerfile. [`.dockerignore`](../.dockerignore) keeps `site/package.json` in the build context so the workspace lockfile stays valid under frozen installs; the rest of `site/` stays excluded.

Canonical quick start steps live in [README.md](../README.md) **Getting Started**.

## Development

### Scripts

| Script                                 | Purpose                                     |
| -------------------------------------- | ------------------------------------------- |
| `nub src/index.ts` / `nub run dev`     | Run `src/index.ts` (`ROLE` env)             |
| `nub watch src/index.ts`               | Auto-restart dev entry                      |
| `nub run build`                        | Compile to `dist/`                          |
| `nub run start` / `node dist/index.js` | Run compiled `dist/`                        |
| `nub run typecheck`                    | `tsc --noEmit` (`src/` only)                |
| `nub run lint`                         | Type-aware Oxlint (includes `site/`)        |
| `nub run lint:backend`                 | Type-aware Oxlint excluding `site/`         |
| `nub run lint:fix`                     | Oxlint with safe fixes                      |
| `nub run fmt`                          | Format with Oxfmt                           |
| `nub run fmt:check`                    | Check formatting                            |
| `nub run check:code`                   | `typecheck` + `lint` + `fmt:check`          |
| `nub run check:effect-versions`        | Verify pinned Effect deps                   |
| `nub run check:prod-deps`              | Production dependency graph guard           |
| `nub run test`                         | Vitest (`test/**/*.test.ts`)                |
| `nub run test:watch`                   | Vitest watch mode                           |
| `nub run test:integration`             | Vitest integration suite                    |
| `nub run --node test`                  | Vitest via plain Node (escape hatch)        |
| `nub run site:dev`                     | Landing site local dev (`pr-agent-landing`) |
| `nub run site:build`                   | Landing site production build               |
| `nub run site:generate-og`             | Generate landing OG assets                  |

Type awareness comes from [`.oxlintrc.json`](../.oxlintrc.json) `options.typeAware` (lint scripts do not pass `--type-aware`). Keep `nub run typecheck` as separate `tsc`. Type-aware lint requires `oxlint-tsgolint` (dev dependency). [`pnpm-workspace.yaml`](../pnpm-workspace.yaml) sets `minimumReleaseAge: 10080` (7 days) for registry installs, with temporary `minimumReleaseAgeExclude` entries: Oxc (`oxlint@1.75.0`, `oxlint-tsgolint@7.0.2001`, `@oxlint/*`, `@oxlint-tsgolint/*`) — remove after 2026-07-29; Pi 0.82.1 (`@earendil-works/pi-*@0.82.1`) plus `evlog@2.22.3`, `oxfmt@0.60.0` / `@oxfmt/*`, `pg-boss@12.26.3`, `posthog-node@5.46.1` / `@posthog/*` — remove after 2026-08-01; `brace-expansion@5.0.8` (GHSA-mh99-v99m-4gvg override in `package.json`) — remove override + exclude after 2026-07-30 once upstream ages past the gate.

### Effect version gate

`nub run check:effect-versions` enforces pinned versions:

- `effect@3.22.0`
- `@effect/platform@0.97.0`
- `@effect/platform-node@0.108.0`

`nub run test` runs this gate before Vitest (`pretest`).

Agent index: [AGENTS.md](../AGENTS.md).

## Security

- Treat `WEBHOOK_SECRET` and app private keys as production secrets.
- **`/ask`** applies deterministic outbound redaction (tokens, host URLs, PEM blocks) before posting replies; obvious bot-internals probes get an **Ask meta refusal** without an LLM call ([ADR 0010](adr/0010-ask-red-team-hardening.md)).
- **Triage report comments** run through the same public-output redactor before upsert to GitHub (normal and report-only paths).
- **PostHog** is optional: enabled only when `POSTHOG_PROJECT_TOKEN` is non-empty (`src/analytics` facade; empty token means no SDK load). When enabled, exception autocapture stays on and a central `before_send` sanitizer redacts secret-shaped substrings in `$exception_list` values/stack strings and `error_message` properties for both explicit and autocaptured exceptions ([ADR 0010](adr/0010-ask-red-team-hardening.md)). `logError` also forwards terminal failures into PostHog with `AppError` fields when present.
- **Classified external failures** — Terminal and soft-fail agent-work events carry `failure_domain` (`provider` | `github` | `internal` | `unknown`), `error_kind` (provider: `auth`/`quota`/`billing`/`rate_limit`/`timeout`; GitHub: `auth`/`forbidden`/`not_found`/`validation`/`rate_limit`; plus `validation`/`publish`/`cancelled`/`superseded`/`unknown`), and sanitized `error_message`. Query these on `review failed`, `work item failed`, `ask failed`, `description failed`, `triage failed`, and `verification failed`. Durable `"work item failed"` also keeps `provider_error_kind` when `failure_domain === "provider"`. Superseded/cancelled/stale-head runs use `failure_domain=internal` with `error_kind` in `{superseded,cancelled}` — never provider. Matching evlog fields use camelCase (`failureDomain`, `errorKind`, `errorMessage`) on `review_not_published`, `agent_publish_fallback`, `agent_work_failed`, and siblings. Classification is logs/analytics only; PR-facing failure notices stay neutral.
- **Review duration vs provider TPS** — `"review published"` and `"review failed"` include `wall_clock_ms`, `provider_output_tokens`, `generation_ms`, and (when `generation_ms > 0`) derived `provider_output_tps` = tokens / (generation_ms/1000), plus `token_coverage` (`orchestrator_only` \| `full_run`). Use these to separate slow reviews caused by provider generation speed from failures (`failure_domain` / `error_kind`) and retry/degraded runs (`publish_attempts > 1` or `tool_call_errors > 0`). Do not treat wall-clock alone as provider TPS. Suggested dashboard gate: `wall_clock_ms >= 180000`; provider-TPS-slow when also `provider_output_tps < 10` with no retry signal.
- Structured logging uses [evlog](https://www.evlog.dev) with `service: pr-agent`. `LOG_LEVEL` maps to evlog `minLevel` (default `info`). `LOG_MAX_WIDE_EVENTS` (code constant, default `128`) caps sub-events per webhook/worker operation. `LOG_REDACT` (default true) redacts secret-shaped substrings from logs. `LOG_PRETTY` defaults to off in production (JSON lines).
- Production logging should stay at `info` unless debugging a specific review run (`LOG_LEVEL=debug`).
