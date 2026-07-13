# Operations and behaviour

Behaviour semantics, deployment detail, and developer scripts for **pr-agent**. For env tunables see [configuration.md](configuration.md). For queue SQL and recovery see [agent-work-ops.md](agent-work-ops.md). Domain terms: [CONTEXT.md](../CONTEXT.md).

## What the service does

- On configured **`pull_request`** actions (`REVIEW_AUTO_ACTIONS`; `opened` by default), enqueues an automated **Review run**; on `opened`, it also enqueues a **Description run**; on `synchronize`, it also enqueues a **Verification run** that re-checks open bot inline findings against the new head (`VERIFICATION_AUTO_ACTIONS`; empty disables). Review workers add an acknowledgement reaction on the PR issue, post a **review progress comment** stub, run the multi-agent review pipeline, and upsert **`## PR Agent Review`** on the **PR conversation** when synthesis succeeds. Description workers merge generated content into the PR body under **`## PR Agent Description`**, preserving user-authored text above that header (by default the PR title is not overwritten). A pull request review on the Files tab (with inline P0 to P2 threads) is posted only when those severities are present; its **review pointer body** includes a collapsible **agent fix prompt** aggregating all findings.
- On **`issue_comment`** and **`pull_request_review_comment`** (`created` only), detects `/help`, `/ask`, `/describe`, `/review`, and `/triage`, enqueues **agent work items**, and routes commands. Removed lens commands receive the normal help guidance and do not enqueue review work. **PR-surface I/O** (reactions, replies, reviews) is published by workers, not on the webhook fiber.
- Responds **`200`** after **durable intake** commits to Postgres and pg-boss jobs are enqueued (or **`503`** if intake cannot commit; GitHub may redeliver). Reactions, progress comments, reviews, and ask answers run in **`ROLE=worker`** and may appear seconds after the HTTP response. The webhook does not wait for LLM runs to finish.

Architecture: [ADR 0009](adr/0009-durable-agent-work.md).

## Behaviour and semantics

- **Payload boundary:** each subscribed `X-GitHub-Event` type is validated with minimal Zod shapes before deduplication. Malformed payloads are logged and skipped without inserting a dedupe row (so GitHub retries can succeed after fixes or transient issues).
- **Slash commands** are detected on the **first non-empty line** only, and are **case-sensitive** (`/review` works; `/Review` does not). `/ask <question>` answers one question about the PR or a specific diff line (**code anchor**).
- **Webhook deduplication** is durable: `webhook_events.dedupe_key` uses `X-GitHub-Delivery` when present, otherwise SHA-256(raw body). Duplicate deliveries return **`200`** without creating duplicate **agent work items**.
- **Review superseding:** on configured automated review actions, newer automated work supersedes queued auto-reviews for the same PR and requests cooperative cancel on an in-flight auto-review. Slash-command reviews are not superseded by intake. Separately, any in-flight review (auto or slash) that sees a newer PR head mid-run cancels cooperatively and may schedule one replacement review for that head (stale-head reschedule).
- **Reviewer fan-out:** every full Review run creates independent read-only reviewer sessions selected by **Review budget tier**. Small tiers run all eight angles (correctness, security, tests, maintainability, project standards, reliability, API/contracts, adversarial). Medium and large tiers run the core four (correctness, security, tests, maintainability). They share one prepared local PR workspace but have isolated session state and cannot publish. At most **`REVIEW_AGENT_CONCURRENCY`** reviewer sessions run simultaneously (default `4`, env-backed). Reviewer agents omitted by tier are expected policy, not failures. Truncated change sets are never classified as small.
- **Required coverage and validation:** correctness and security reports are required; if either fails, the Review run fails without synthesis. Other _selected_ reviewer failures are reported to the orchestrator as degraded coverage. Candidate P0/P1 findings receive an independent validator pass before synthesis (capped by **`REVIEW_VALIDATION_MAX_CANDIDATES`**, default `16`); rejected candidates are omitted.
- **Review synthesis and publish:** one orchestrator session receives the reviewer reports, degraded-coverage state, and read-only tools. It synthesizes only — it does not rediscover the full change set. It is the only session with **`submitReview`** and must produce one complete ReviewPayload. The orchestrator investigation phase is capped by **`MAX_TOOL_ROUNDS_ORCHESTRATOR`** (default **`MAX_TOOL_ROUNDS`** / `8`); reviewer and validator sessions use **`MAX_TOOL_ROUNDS_REVIEWER`** (default `16`) and **`MAX_TOOL_ROUNDS_VALIDATOR`** (default `8`). If **`submitReview`** never succeeds, publish-recovery nudges run up to **`MAX_REVIEW_PUBLISH_ATTEMPTS`**, then a plain-text fallback comment may be posted when structured publish is exhausted.
- **Review pointer link:** on the second and later Review runs per PR, the Files-tab pointer links to the existing **review summary comment** when it can be verified; the first completed summary uses plain text only.
- **Merge verdict:** the review summary includes a **Merge verdict** row with a model score (/5) and one-sentence rationale. When P0/P1 findings are open, validation clamps the score to ≤3 and rejects safe-to-merge wording; when the model omits the verdict, a mechanical fallback is shown.
- **File walkthrough link:** the summary's per-file +/- walkthrough table is replaced by a link to the PR description's File Walkthrough when a Description agent block exists.
- **Worker concurrency:** review, ask, acknowledgement, description, triage, and verification jobs are capped per process by **`REVIEW_CONCURRENCY`** (default `2`), **`ASK_CONCURRENCY`** (default `1`), **`ACK_CONCURRENCY`** (default `2`), **`DESCRIPTION_CONCURRENCY`** (default `1`), **`TRIAGE_CONCURRENCY`** (default `1`), and **`VERIFICATION_CONCURRENCY`** (default `1`) via pg-boss worker `localConcurrency` ([`src/agentWork/worker.ts`](../src/agentWork/worker.ts)). During fan-out, a worker process can therefore run up to `REVIEW_CONCURRENCY × REVIEW_AGENT_CONCURRENCY` reviewer sessions. Validator and orchestrator sessions run after that fan-out for each job. Multi-replica deployments multiply the provider load and remain at-least-once at the worker layer.
- **Tool surface:** reviewer agents, validators, the Review orchestrator, and ask agents use the local workspace tools `listChangedFiles`, `readWorkspaceFile`, `searchWorkspace`, `getWorkspaceDiff`, and `getWorkspaceBlame`, plus 2 Context7 doc tools. GitHub reads happen server-side during preflight and publish. Reviewer agents can only submit internal reports, validators can only submit validation verdicts, and **`submitReview`** is reserved for the orchestrator. See [ADR 0004](adr/0004-native-pi-ai-toolset.md).
- **Library docs lookup:** review and ask agents get Context7 tools (`resolveLibraryId`, `getLibraryDocs`) that hit `https://context7.com/api`. Set **`CONTEXT7_API_KEY`** for higher limits and private repos. See [ADR 0003](adr/0003-context7-docs-tool.md).
- **Cursor provider:** set **`AGENT_PROVIDER=cursor`**, **`CURSOR_API_KEY`**, and **`PI_MODEL`** (e.g. `composer-2.5`). Worker registers pi-ai api `cursor-sdk` and runs Cursor local agents with an HTTP MCP bridge to pr-agent's GitHub, Context7, and submitReview tools. See [ADR 0013](adr/0013-cursor-sdk-provider.md).
- **Bot identity** for self-suppression is cached per **`GITHUB_APP_ID`**, so multiple GitHub Apps in one process do not share the same cache entry.
- **`WEBHOOK_TIMEOUT_MS`** (default `10000`) is the webhook intake response budget. Intake that exceeds this budget minus `GITHUB_WEBHOOK_RESPONSE_MARGIN_MS` returns **`503`** before GitHub reports a delivery timeout. Worker jobs are still supervised separately.
- **`/review`:** the only review command. It selects the Reviewer roster from the **Review budget tier** and publishes through the single `## PR Agent Review` surface.
- **`/triage`:** trigger-only autofix work type. Post `/triage` on the PR conversation to triage all unresolved bot inline findings. Reply `/triage` inside a bot inline finding thread to triage that finding only. Historical findings from removed review-lens commands remain eligible. Triage skips fork PR pushes, fixes same-repo findings in an isolated writable checkout, commits with validated messages, pushes without force, replies/resolves only after push succeeds, and upserts **`## PR Agent Triage`**. The bot push triggers a normal `synchronize` verification run; that is expected fix validation. GitHub App needs **Contents: read/write** for this command.
- **Verification runs:** auto-triggered on `pull_request` `synchronize` (`VERIFICATION_AUTO_ACTIONS`, default `synchronize`; empty disables). Read-only: re-checks open bot inline findings against the new head. **Fixed** and **already-resolved** threads are resolved silently (no reply). Thread replies are posted only for **still-open** findings on files changed in the push, and for **dismissed** findings (with a policy suggestion). No ack reaction, progress comment, or summary comment is posted.
- **Policy suggestions for dismissed findings:** when triage or verification dismisses a finding, the bot drafts a paste-ready `.pr-agent.yml` `pathInstructions` snippet to steer future reviews away from that pattern.
- **`/ask`:** interactive Q&A about PR code. Runs on the **`agent-work-ask`** pg-boss queue. See [ADR 0008](adr/0008-ask-command.md).
- **Lightweight review completion:** automated reviews on docs-only trivial PRs may finish without a full **Review run** (**trivial change exemption**). Slash `/review` always requests the full multi-agent pipeline. See [ADR 0014](adr/0014-lightweight-review-completion.md).

## Large PRs and GitHub rate limits

- **`@octokit/plugin-throttling`** paces all installation-token REST calls (review tools, publish, reactions). Tune via env: `MAX_PR_FILES_LISTED` (default `300`), `MAX_PR_FILES_PATCH_BYTES` (default `500000`).
- On tool failures, logs emit `github_tool_request_error` with `x-github-request-id`, `x-ratelimit-*`, and a classification. Capture a redacted sample when debugging production limits.
- See [ADR 0007](adr/0007-github-api-rate-limits.md) for policy (secondary-limit retries and truncation trade-offs).

## Deployment

### Docker and Docker Compose

- **Stack:** [docker-compose.yml](../docker-compose.yml) runs **`postgres`**, **`pr-agent-web`** (`ROLE=web`), and **`pr-agent-worker`** (`ROLE=worker`). `docker compose up` is required for end-to-end reviews and asks; web-only is not sufficient.
- **Image:** multi-stage `Dockerfile` (Node 22); runtime listens on **`PORT`** (pinned to **7224** in Compose and [`.env.example`](../.env.example)).
- **Health probes (web vs worker):** canonical table in [agent-work-ops.md](agent-work-ops.md#probes-web-vs-worker). Summary:
  - **Web `GET /health`**: process liveness (`ok`). Does not prove Postgres or workers are healthy.
  - **Web `GET /ready`**: webhook intake readiness — Postgres `SELECT 1` only. A 200 means durable intake can accept deliveries; it does **not** mean workers are consuming queues.
  - **Worker `GET /health`**: worker process liveness (`ok`).
  - **Worker `GET /ready`**: worker readiness — consumers registered, pg-boss polling fresh (`WORKER_READINESS_POLL_STALE_SECONDS`), and Postgres/pg-boss reachable. Idle workers with empty queues still report ready. Empty queues alone never imply healthy.
  - Compose wires **web** healthchecks to `/health` and **worker** healthchecks to `/ready`.
- **Webhook URL** (default Compose ports): `http://<host>:7224/webhooks`.
- **`DATABASE_URL`** in Compose: `postgres://pr_agent:pr_agent@postgres:5432/pr_agent`.
- **Provider API keys** (for example **`OPENAI_API_KEY`** or **`CURSOR_API_KEY`** when using the Cursor provider) are not fully read by [`src/config.ts`](../src/config.ts) except `CURSOR_API_KEY` when selected; other Pi AI secrets load from the environment. Set them in `.env` beside the GitHub fields or reviews fail at runtime in the worker.
- **Secrets:** never commit `.env`; keep Compose files off public pastebins.
- **Provider pressure:** worker startup logs `review_provider_pressure` with derived max concurrent reviewer sessions (`REVIEW_CONCURRENCY × REVIEW_AGENT_CONCURRENCY` per process) plus validation/orchestrator caps (ADR 0022). Continuous `agent_queue_stall_diagnostic` logs cover depth/age, DLQs, blocked singleton keys, and oldest running agent work items.

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
- Structured logging uses [evlog](https://www.evlog.dev) with `service: pr-agent`. `LOG_LEVEL` maps to evlog `minLevel` (default `info`). `LOG_MAX_WIDE_EVENTS` (default `128`) caps sub-events per webhook/worker operation. `LOG_REDACT` (default true) redacts secret-shaped substrings from logs. `LOG_PRETTY` defaults to off in production (JSON lines).
- Production logging should stay at `info` unless debugging a specific review run (`LOG_LEVEL=debug`).

## Review pipeline rollout

The Review pipeline has three rollout modes selected by `REVIEW_PIPELINE_MODE` (ADR 0024):

| Mode    | Publishing pipeline | Shadow comparison | Notes |
| ------- | ------------------- | ----------------- | ----- |
| `legacy`  | Eight-role Reviewer roster | None | Default; current behavior |
| `shadow`  | Eight-role Reviewer roster | Sampled hybrid (non-publishing) | `REVIEW_SHADOW_SAMPLE_RATE` controls sampling fraction |
| `hybrid`  | Four-critic pipeline | None | Target architecture after gates pass |

### SLO measurement

Eligible, non-cancelled, non-SLO-exempt Reviews target a median webhook-to-publication latency of at most three minutes and a p95 of at most five minutes. Large or truncated Reviews are recorded as SLO-exempt and may exceed the target to preserve comprehensive coverage.

### Rollout gates

Default cutover to `hybrid` requires all of the following:

1. **Historical replay:** At least 50 adjudicated PRs retain every known valid P0-P2; hybrid's observed false-positive rate does not exceed legacy and the 95% confidence bound excludes a regression above two percentage points.
2. **Live shadow:** At least seven days and 300 eligible paired Reviews show no confirmed legacy-only P0-P2 and hybrid meets latency SLOs for non-exempt runs.
3. **Publishing canary:** At least 300 eligible, non-cancelled canary Reviews publish at least 99% without manual retry; no duplicate public payloads.

Rollback to `legacy` is available until final cleanup. Set `REVIEW_PIPELINE_MODE=legacy` to return publishing traffic to the eight-role roster; critic and payload checkpoint data is preserved.

### Replay script

```bash
node scripts/review-replay.mjs test/fixtures/review-replay/manifest.json
```

Loads a versioned replay manifest, runs both pipelines through a publication-free evaluation boundary, and prints gate results.
