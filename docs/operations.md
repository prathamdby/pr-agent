# Operations and behaviour

Behaviour semantics, deployment detail, and developer scripts for **pr-agent**. For env tunables see [configuration.md](configuration.md). For queue SQL and recovery see [agent-work-ops.md](agent-work-ops.md). Domain terms: [CONTEXT.md](../CONTEXT.md).

## What the service does

- On **`pull_request`** (`opened`, `synchronize`, `reopened`), enqueues an automated general **review run**; on `opened`, it also enqueues a **description run**; on `synchronize`, it also enqueues a **verification run** that re-checks open bot inline findings against the new head (`VERIFICATION_AUTO_ACTIONS`; empty disables). Review workers add an acknowledgement reaction on the PR issue, post a **review progress comment** stub, run an agent loop, and upsert **`## PR Agent Review`** on the **PR conversation** when the model succeeds. Description workers merge generated content into the PR body under **`## PR Agent Description`**, preserving user-authored text above that header (by default the PR title is not overwritten). A pull request review on the Files tab (with inline P0 to P2 threads) is posted only when those severities are present; its **review pointer body** includes a collapsible **agent fix prompt** aggregating all findings.
- On **`issue_comment`** and **`pull_request_review_comment`** (`created` only), detects `/help`, `/ask`, `/describe`, `/review`, `/review-security`, `/review-quality`, `/review-tests`, and `/triage`, enqueues **agent work items**, and routes commands. **PR-surface I/O** (reactions, replies, reviews) is published by workers, not on the webhook fiber.
- Responds **`200`** after **durable intake** commits to Postgres and pg-boss jobs are enqueued (or **`503`** if intake cannot commit; GitHub may redeliver). Reactions, progress comments, reviews, and ask answers run in **`ROLE=worker`** and may appear seconds after the HTTP response. The webhook does not wait for LLM runs to finish.

Architecture: [ADR 0009](adr/0009-durable-agent-work.md).

## Behaviour and semantics

- **Payload boundary:** each subscribed `X-GitHub-Event` type is validated with minimal Zod shapes before deduplication. Malformed payloads are logged and skipped without inserting a dedupe row (so GitHub retries can succeed after fixes or transient issues).
- **Slash commands** are detected on the **first non-empty line** only, and are **case-sensitive** (`/review` works; `/Review` does not). `/ask <question>` answers one question about the PR or a specific diff line (**code anchor**).
- **Webhook deduplication** is durable: `webhook_events.dedupe_key` uses `X-GitHub-Delivery` when present, otherwise SHA-256(raw body). Duplicate deliveries return **`200`** without creating duplicate **agent work items**.
- **Review superseding:** on `pull_request` **`synchronize`**, newer automated general-lens work supersedes queued auto-reviews for the same PR and requests cooperative cancel on an in-flight auto-review. Slash-command reviews are not superseded.
- **Agent loop (reviews):** capped at **`MAX_TOOL_ROUNDS`** (tools required on the first round). Each **review run** is a **single-pass review**: one investigation sweep, then one **`submitReview`** with all evidenced P0 to P2 findings. If **`submitReview`** never succeeds, publish-recovery nudges run up to **`MAX_REVIEW_PUBLISH_ATTEMPTS`**, then a plain-text fallback comment may be posted when structured publish is exhausted.
- **Review pointer link:** on the second and later review runs per PR and **review lens**, the Files-tab pointer links to the existing **review summary comment** when it can be verified; the first completed summary for that lens uses plain text only.
- **Merge verdict:** the general review summary includes a **Merge verdict** row with a model score (/5) and one-sentence rationale. When P0/P1 findings are open, validation clamps the score to ≤3 and rejects safe-to-merge wording; when the model omits the verdict, a mechanical fallback is shown.
- **File walkthrough link:** the summary's per-file +/- walkthrough table is replaced by a link to the PR description's File Walkthrough when a Description agent block exists.
- **Worker concurrency:** review, ask, acknowledgement, description, triage, verification, and thread-reply classification jobs are capped per process by **`REVIEW_CONCURRENCY`** (default `2`), **`ASK_CONCURRENCY`** (default `1`), **`ACK_CONCURRENCY`** (default `2`), **`DESCRIPTION_CONCURRENCY`** (default `1`), **`TRIAGE_CONCURRENCY`** (default `1`), **`VERIFICATION_CONCURRENCY`** (default `1`), and **`THREAD_REPLY_CLASSIFY_CONCURRENCY`** (default `2`) via pg-boss worker `localConcurrency` ([`src/agentWork/worker.ts`](../src/agentWork/worker.ts)). Multi-replica deployments remain at-least-once at the worker layer.
- **Tool surface:** production review and ask agents use the local workspace tools `listChangedFiles`, `readWorkspaceFile`, `searchWorkspace`, `getWorkspaceDiff`, and `getWorkspaceBlame`, plus 2 Context7 doc tools. GitHub reads happen server-side during preflight and publish, and **`submitReview`** remains the only publish path. See [ADR 0004](adr/0004-native-pi-ai-toolset.md).
- **Library docs lookup:** review and ask agents get Context7 tools (`resolveLibraryId`, `getLibraryDocs`) that hit `https://context7.com/api`. Set **`CONTEXT7_API_KEY`** for higher limits and private repos. See [ADR 0003](adr/0003-context7-docs-tool.md).
- **Cursor provider:** set **`AGENT_PROVIDER=cursor`**, **`CURSOR_API_KEY`**, and **`PI_MODEL`** (e.g. `composer-2.5`). Worker registers pi-ai api `cursor-sdk` and runs Cursor local agents with an HTTP MCP bridge to pr-agent's GitHub, Context7, and submitReview tools. See [ADR 0013](adr/0013-cursor-sdk-provider.md).
- **Bot identity** for self-suppression is cached per **`GITHUB_APP_ID`**, so multiple GitHub Apps in one process do not share the same cache entry.
- **`WEBHOOK_TIMEOUT_MS`** (default `10000`) is the webhook intake response budget. Intake that exceeds this budget minus `GITHUB_WEBHOOK_RESPONSE_MARGIN_MS` returns **`503`** before GitHub reports a delivery timeout. Worker jobs are still supervised separately.
- **`/review-security`:** trigger-only deep security **review lens** (see [NOTICES.md](../NOTICES.md)). Never runs on `pull_request` webhooks. Posts **`## PR Agent Security Review`**, which can coexist with the general **review summary comment**.
- **`/review-quality`:** trigger-only deep quality **review lens** (see [NOTICES.md](../NOTICES.md) and [ADR 0016](adr/0016-review-quality-lens.md)). Never runs on `pull_request` webhooks. Posts **`## PR Agent Quality Review`**.
- **`/review-tests`:** trigger-only test-planning **review lens**. Never runs on `pull_request` webhooks. Posts **`## PR Agent Tests Review`** with proposed test cases; it does not write test files or push commits.
- **`/triage`:** trigger-only autofix work type. Post `/triage` on the PR conversation to triage all unresolved bot inline findings across review, security, quality, and review-tests lenses. Reply `/triage` inside a bot inline finding thread to triage that finding only. Reads earlier bot inline findings, skips fork PR pushes, fixes same-repo findings in an isolated writable checkout, commits with validated messages, pushes without force, replies/resolves only after push succeeds, and upserts **`## PR Agent Triage`**. The bot push triggers a normal `synchronize` review run; that is expected fix validation. GitHub App needs **Contents: read/write** for this command.
- **Verification runs:** auto-triggered on `pull_request` `synchronize` (`VERIFICATION_AUTO_ACTIONS`, default `synchronize`; empty disables). Read-only: re-checks open bot inline findings against the new head. **Fixed** and **already-resolved** threads are resolved silently (no reply). Thread replies are posted only for **still-open** findings on files changed in the push, and for **dismissed** findings (with a policy suggestion). No ack reaction, progress comment, or summary comment is posted.
- **Policy suggestions for dismissed findings:** when triage or verification dismisses a finding, the bot drafts a paste-ready `.pr-agent.yml` `pathInstructions` snippet to steer future reviews away from that pattern.
- **`/ask`:** interactive Q&A about PR code. Runs on the **`agent-work-ask`** pg-boss queue. See [ADR 0008](adr/0008-ask-command.md). When **`ENABLE_THREAD_REPLIES=true`**, non-slash replies in bot inline review threads are classified on **`agent-work-thread-classify`** then promoted to ask intake ([ADR 0022](adr/0022-thread-reply-classification-worker.md)).
- **Lightweight review completion:** automated general reviews on docs-only trivial PRs may finish without a full **review run** (**trivial change exemption**). See [ADR 0014](adr/0014-lightweight-review-completion.md).

## Large PRs and GitHub rate limits

- **`@octokit/plugin-throttling`** paces all installation-token REST calls (review tools, publish, reactions). Tune via env: `MAX_PR_FILES_LISTED` (default `300`), `MAX_PR_FILES_PATCH_BYTES` (default `500000`).
- On tool failures, logs emit `github_tool_request_error` with `x-github-request-id`, `x-ratelimit-*`, and a classification. Capture a redacted sample when debugging production limits.
- See [ADR 0007](adr/0007-github-api-rate-limits.md) for policy (secondary-limit retries and truncation trade-offs).

## Deployment

### Docker and Docker Compose

- **Stack:** [docker-compose.yml](../docker-compose.yml) runs **`postgres`**, **`pr-agent-web`** (`ROLE=web`), and **`pr-agent-worker`** (`ROLE=worker`). `docker compose up` is required for end-to-end reviews and asks; web-only is not sufficient.
- **Image:** multi-stage `Dockerfile` (Node 22); runtime listens on **`PORT`** (pinned to **7224** in Compose and [`.env.example`](../.env.example)).
- **Health:** `GET /health` returns `200` and plain `ok`. `GET /ready` runs a Postgres `SELECT 1` and returns `503` when the database is unreachable (orchestrator readiness gating).
- **Webhook URL** (default Compose ports): `http://<host>:7224/webhooks`.
- **`DATABASE_URL`** in Compose: `postgres://pr_agent:pr_agent@postgres:5432/pr_agent`.
- **Provider API keys** (for example **`OPENAI_API_KEY`** or **`CURSOR_API_KEY`** when using the Cursor provider) are not fully read by [`src/config.ts`](../src/config.ts) except `CURSOR_API_KEY` when selected; other Pi AI secrets load from the environment. Set them in `.env` beside the GitHub fields or reviews fail at runtime in the worker.
- **Secrets:** never commit `.env`; keep Compose files off public pastebins.

```bash
cp .env.example .env
docker compose build
docker compose up
```

Compose sets `environment.PORT=7224` and **`7224:7224`** publishing. For a host port clash, change **`ports`** to for example **`7227:7224`** and keep container **`PORT`** at **7224**.

**Requires Docker Engine with Compose v2.** `env_file` defaults to **`.env`**; use host env **`PR_AGENT_ENV_FILE`** for an alternate path.

The Compose `postgres` service sets `shm_size: 128mb` and conservative server tuning flags (`shared_buffers`, `effective_cache_size`, `maintenance_work_mem`, `wal_compression`, `random_page_cost`). Override them with the `POSTGRES_SHARED_BUFFERS`, `POSTGRES_EFFECTIVE_CACHE_SIZE`, `POSTGRES_MAINTENANCE_WORK_MEM`, `POSTGRES_WAL_COMPRESSION`, and `POSTGRES_RANDOM_PAGE_COST` Compose env vars; the production override mirrors the same flags.

```bash
PR_AGENT_ENV_FILE=/abs/path/to/.env docker compose up
```

### Runtime (Effect TS)

- Production boot uses a **web/worker split** (`ROLE` env).
- **Web:** [`processWebhookRequestEffect`](../src/effect/programs/processWebhookRequestEffect.ts) verifies signatures, parses payloads, and dispatches to [`WebhookHandlers`](../src/effect/services/webhookHandlers.ts), which call [`AgentWorkScheduler`](../src/agentWork/scheduler.ts) for Postgres intake and pg-boss enqueue.
- **Worker:** [`agentWorkWorkerLive`](../src/agentWork/runtime.ts) consumes acknowledgement, review, ask, description, triage, and verification queues; PR-surface I/O and LLM runs happen via [`executors/`](../src/agentWork/executors/).

### Local development edge cases

- **`nub src/index.ts` loads `.env` automatically** for local development. `nub watch src/index.ts` restarts on source, tsconfig, and env changes.
- **`GITHUB_APP_PRIVATE_KEY` must be a valid PEM key**. For local-only dev: `openssl genrsa 2048 > key.pem` and set the escaped PEM in `.env`.
- Tunnel webhooks (e.g. [smee.io](https://smee.io)) to local `PORT`, then point the GitHub App webhook at the smee URL forwarding to `/webhooks`.
- If switching from pnpm-installed trees, delete `node_modules` before the first `nub install`.
- **Vercel** site deploys still use pnpm via [`site/vercel.json`](../site/vercel.json).

Canonical quick start steps live in [README.md](../README.md) **Getting Started**.

## Development

### Scripts

| Script                                 | Purpose                              |
| -------------------------------------- | ------------------------------------ |
| `nub src/index.ts`                     | Run `src/index.ts` (`ROLE` env)      |
| `nub watch src/index.ts`               | Auto-restart dev entry               |
| `nub run build`                        | Compile to `dist/`                   |
| `nub run start` / `node dist/index.js` | Run compiled `dist/`                 |
| `nub run typecheck`                    | `tsc --noEmit` (`src/` only)         |
| `nub run lint`                         | Type-aware Oxlint                    |
| `nub run lint:fix`                     | Oxlint with safe fixes               |
| `nub run fmt`                          | Format with Oxfmt                    |
| `nub run fmt:check`                    | Check formatting                     |
| `nub run check:code`                   | `typecheck` + `lint` + `fmt:check`   |
| `nub run check:effect-versions`        | Verify pinned Effect deps            |
| `nub run test`                         | Vitest (`test/**/*.test.ts`)         |
| `nub run test:watch`                   | Vitest watch mode                    |
| `nub run --node test`                  | Vitest via plain Node (escape hatch) |

Type-aware lint requires `oxlint-tsgolint` (dev dependency). [`pnpm-workspace.yaml`](../pnpm-workspace.yaml) sets `minimumReleaseAge: 10080` (7 days) for registry installs.

### Effect version gate

`nub run check:effect-versions` enforces pinned versions:

- `effect@3.21.2`
- `@effect/platform@0.96.1`
- `@effect/platform-node@0.106.0`

`nub run test` runs this gate before Vitest (`pretest`).

Maintainer rules: [AGENTS.md](../AGENTS.md).

## Security

- Treat `WEBHOOK_SECRET` and app private keys as production secrets.
- **`/ask`** applies deterministic outbound redaction (tokens, host URLs, PEM blocks) before posting replies; obvious bot-internals probes get an **Ask meta refusal** without an LLM call ([ADR 0010](adr/0010-ask-red-team-hardening.md)).
- **Triage report comments** run through the same public-output redactor before upsert to GitHub (normal and report-only paths).
- **PostHog** keeps exception autocapture enabled; a central `before_send` sanitizer redacts secret-shaped substrings in `$exception_list` values/stack strings and `error_message` properties for both explicit and autocaptured exceptions ([ADR 0010](adr/0010-ask-red-team-hardening.md)).
- Structured logging uses [evlog](https://www.evlog.dev) with `service: pr-agent`. `LOG_LEVEL` maps to evlog `minLevel` (default `info`). `LOG_MAX_WIDE_EVENTS` (default `128`) caps sub-events per webhook/worker operation. `LOG_REDACT` (default true) redacts secret-shaped substrings from logs. `LOG_PRETTY` defaults to off in production (JSON lines).
- Production logging should stay at `info` unless debugging a specific review run (`LOG_LEVEL=debug`).
