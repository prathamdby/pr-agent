# pr-agent

GitHub App webhook service that performs automated pull request reviews using native **Octokit** REST tools ([`src/agent/githubTools.ts`](src/agent/githubTools.ts)) and [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi/tree/main/packages/ai) (LLM + tool loop).

Durable agent work (Postgres intake + pg-boss workers) is described in [docs/adr/0009-durable-agent-work.md](docs/adr/0009-durable-agent-work.md). Operations runbooks: [docs/agent-work-ops.md](docs/agent-work-ops.md). Domain terms: [CONTEXT.md](CONTEXT.md). All tunables: [docs/configuration.md](docs/configuration.md).

## What it does

- On **`pull_request`** (`opened`, `synchronize`, `reopened`), enqueues an automated general review **and** an automated PR description run. Review workers add 👀 (`eyes`) on the PR issue, post a progress stub, run an agent loop, and upsert **`## PR Agent Review`** on the PR conversation when the model succeeds. Description workers merge generated content into the PR body under **`## PR Agent Description`**, preserving any text you wrote above that header (by default the PR title is not overwritten). A pull request review on the Files tab (with inline P0–P2 threads) is posted only when those severities are present; its review pointer body includes a collapsible **agent fix prompt** aggregating all findings for copy-paste into coding agents.
- On **`issue_comment`** and **`pull_request_review_comment`** (`created` only), detects `/help`, `/ask`, `/describe`, `/review`, `/review-security`, and `/review-quality`, enqueues work, and routes commands. Reactions and replies are published by workers, not on the webhook fiber.
- Responds **`200`** after **durable intake commits** to Postgres and pg-boss jobs are enqueued (or **`503`** if intake cannot commit — GitHub may redeliver). **Reactions, progress comments, reviews, and ask answers** run in **`ROLE=worker`** and may appear **seconds after** the HTTP response. The webhook does **not** wait for LLM runs to finish.

## Behaviour details

- **Payload boundary:** each subscribed `X-GitHub-Event` type is validated with **minimal Zod** shapes before deduplication; malformed payloads are logged and skipped **without** inserting a dedupe row (so GitHub retries can succeed after fixes or transient issues).
- **Slash commands** are detected on the **first non-empty line** only, and are **case-sensitive** (`/review` works; `/Review` does not). `/ask <question>` answers one question about the PR or a specific diff line.
- **Webhook deduplication** is **durable**: `webhook_events.dedupe_key` uses `X-GitHub-Delivery` when present, otherwise **SHA-256(raw body)**. Duplicate deliveries return **`200`** without creating duplicate work items.
- **Auto-review superseding:** on `pull_request` **`synchronize`**, newer automated general-lens work **supersedes** queued auto-reviews for the same PR and requests cooperative cancel on an in-flight auto-review (slash-command reviews are not superseded).
- **Agent loop (reviews):** capped at **`MAX_TOOL_ROUNDS`** (tools required on the first round). Each run is a **single-pass review**: one investigation sweep, then one **`submitReview`** with all evidenced P0–P2 findings (unlimited count; per-field and summary body size limits apply). If **`submitReview`** never succeeds, publish-recovery nudges run up to **`MAX_REVIEW_PUBLISH_ATTEMPTS`**, then a plain-text fallback comment may be posted when structured publish is exhausted.
- **Review pointer link:** on the second and later review runs per PR and lens, the Files-tab pointer links to the existing PR conversation summary comment when it can be verified; the first completed summary for that lens uses plain text only.
- **Worker concurrency:** review, ask, and acknowledgement jobs are capped per process by **`REVIEW_CONCURRENCY`** (default `2`), **`ASK_CONCURRENCY`** (default `1`), and **`ACK_CONCURRENCY`** (default `2`) via pg-boss worker `localConcurrency` ([`src/agentWork/worker.ts`](src/agentWork/worker.ts)). Multi-replica deployments remain **at-least-once** at the worker layer.
- **GitHub tools:** **11** investigation tools in [`src/agent/githubTools.ts`](src/agent/githubTools.ts), plus **2** Context7 doc tools; the server publishes only via **`submitReview`** (no agent-callable comment/review delivery tools). See [docs/adr/0004-native-pi-ai-toolset.md](docs/adr/0004-native-pi-ai-toolset.md).
- **Library docs lookup:** review and ask agents get two Context7 tools (`resolveLibraryId`, `getLibraryDocs`) that hit `https://context7.com/api` to verify upstream API claims. Anonymous calls work for public libraries with rate limits; set **`CONTEXT7_API_KEY`** for higher limits and private repos. See [docs/adr/0003-context7-docs-tool.md](docs/adr/0003-context7-docs-tool.md).
- **Cursor provider:** set **`PI_PROVIDER=cursor`**, **`CURSOR_API_KEY`**, and **`PI_MODEL`** (e.g. `composer-2.5`). Worker registers pi-ai api `cursor-sdk` and runs Cursor local agents with an HTTP MCP bridge to pr-agent's GitHub/Context7/submitReview tools. See [docs/adr/0013-cursor-sdk-provider.md](docs/adr/0013-cursor-sdk-provider.md).
- **Bot identity** for self-suppression is cached **per `GITHUB_APP_ID`**, so multiple GitHub Apps in one process do not share the same cache entry.
- **`WEBHOOK_TIMEOUT_MS`** (default `10000`) is a **logging-only** budget on webhook intake duration; it does not cancel worker jobs.
- **`/review-security`** — trigger-only deep security review (DeepSec-adapted prompt; see [NOTICES.md](NOTICES.md)). Never runs on `pull_request` webhooks. Uses the same review worker lane and **`MAX_TOOL_ROUNDS`** as `/review`; large PRs may need a higher `MAX_TOOL_ROUNDS`. Posts a separate summary comment (`## PR Agent Security Review`) that can coexist with the general review summary.
- **`/review-quality`** — trigger-only deep code-quality review (thermo-nuclear-adapted prompt; see [NOTICES.md](NOTICES.md) and [docs/adr/0016-review-quality-lens.md](docs/adr/0016-review-quality-lens.md)). Never runs on `pull_request` webhooks. Uses the same review worker lane and **`MAX_TOOL_ROUNDS`** as `/review`. Posts a separate summary comment (`## PR Agent Quality Review`) focused on maintainability and structural simplification; can coexist with general and security summaries.
- **`/ask`** — interactive Q&A about PR code (PR conversation or inline diff comment). Runs on the **`agent-work-ask`** pg-boss queue with **`ASK_CONCURRENCY`** (default `1`), **`MAX_ASK_TOOL_ROUNDS`** (default `12`), and **`MAX_ASK_FINALIZE_ROUNDS`** (default `2`) for extra model turns when the tool loop ends on tool results. Inline replies are plain text; PR conversation replies repeat the question in a short wrapper. See [docs/adr/0008-ask-command.md](docs/adr/0008-ask-command.md).

## Large PRs and GitHub rate limits

- **`@octokit/plugin-throttling`** paces all installation-token REST calls (review tools, publish, reactions). Tune via env: `MAX_PR_FILES_LISTED` (default `300`), `MAX_PR_FILES_PATCH_BYTES` (default `500000`).
- On tool failures, logs emit `github_tool_request_error` with `x-github-request-id`, `x-ratelimit-*`, and a **classification** — capture a redacted sample when debugging production limits.
- See [docs/adr/0007-github-api-rate-limits.md](docs/adr/0007-github-api-rate-limits.md) for policy (secondary-limit retries, circuit breaker, truncation trade-offs).

## GitHub App setup (summary)

1. Create a GitHub App; set **Webhook URL** to `https://<host>/webhooks` and **Webhook secret** → `WEBHOOK_SECRET`.
2. Subscribe to events: **`pull_request`**, **`issue_comment`**, **`pull_request_review_comment`** (do **not** require `pull_request_review` for v1).
3. Repository permissions (typical): **Issues** and **Pull requests** read/write (reactions + comments + reviews), **Contents** read, **Metadata** read. Tighten further if you fork this code to only the REST calls you need.
4. Install the app on target org/repos; note the **App ID** and generate a **private key** for `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY`.

## Local development

`DATABASE_URL` is **required** for both `ROLE=web` and `ROLE=worker` ([`src/config.ts`](src/config.ts)).

```bash
docker compose up postgres   # or: docker compose up for the full stack
cp .env.example .env         # GITHUB_*, WEBHOOK_SECRET, DATABASE_URL, provider keys — see docs/configuration.md
corepack enable              # Node 22+ ships Corepack; activates pnpm from package.json
pnpm install

# terminal 1 — webhooks only enqueue work
ROLE=web DATABASE_URL=postgres://pr_agent:pr_agent@localhost:5432/pr_agent pnpm dev

# terminal 2 — reactions, reviews, asks
ROLE=worker DATABASE_URL=postgres://pr_agent:pr_agent@localhost:5432/pr_agent pnpm dev
```

`pnpm dev` with **`ROLE=web` alone** accepts webhooks but **does not run reviews or asks** without a worker. See [docs/agent-work-ops.md](docs/agent-work-ops.md) for queue inspection and recovery.

Tunnel webhooks (e.g. [smee.io](https://smee.io)) to your local `PORT`, then point the GitHub App webhook at the smee URL forwarding to `/webhooks`.

### Runtime

- Production boot is Effect TS with a **web/worker split** (`ROLE` env).
- **Web:** [`processWebhookRequestEffect`](src/effect/programs/processWebhookRequestEffect.ts) → [`WebhookDispatcher`](src/effect/services/webhookDispatcher.ts) → [`WebhookHandlers`](src/effect/services/webhookHandlers.ts) + [`AgentWorkScheduler`](src/agentWork/scheduler.ts) (Postgres + pg-boss enqueue).
- **Worker:** [`agentWorkWorkerLive`](src/agentWork/runtime.ts) (`src/worker.ts` entry) consumes acknowledgement, review, ask, and description queues; PR-surface I/O and LLM runs happen on worker fibers via [`executors/`](src/agentWork/executors/).
- Maintainer rules for tunables: [AGENTS.md](AGENTS.md).

### Effect version gate

- `pnpm run check:effect-versions` enforces pinned versions:
  - `effect@3.21.2`
  - `@effect/platform@0.96.1`
  - `@effect/platform-node@0.106.0`
- `pnpm test` runs this version gate before Vitest (`pretest`).

## Docker and Docker Compose

- **Stack:** [docker-compose.yml](docker-compose.yml) runs **`postgres`**, **`pr-agent-web`** (`ROLE=web`), and **`pr-agent-worker`** (`ROLE=worker`). `docker compose up` is required for end-to-end reviews and asks; web-only is not sufficient.
- **Image:** multi-stage `Dockerfile` (Node 22); runtime listens on **`PORT`** (pinned to **7224** in Compose and [`.env.example`](.env.example)).
- **Health:** `GET /health` returns `200` and plain `ok` (used by `HEALTHCHECK` in the image and by Compose). `GET /ready` additionally runs a Postgres `SELECT 1` and returns `503` when the database is unreachable — use it for orchestrator readiness gating.
- **Webhook URL** (when Compose maps default ports): **`http://<host>:7224/webhooks`** — same path as bare Node.
- **`DATABASE_URL`** is set in Compose for both app services (`postgres://pr_agent:pr_agent@postgres:5432/pr_agent`).
- **Provider API keys** (for example **`OPENAI_API_KEY`** or **`CURSOR_API_KEY`** when `PI_PROVIDER=cursor`) are **not** fully read by [`src/config.ts`](src/config.ts) except `CURSOR_API_KEY` when the Cursor provider is selected; other Pi AI secrets load from the environment. Set them in `.env` beside the GitHub fields or reviews fail at runtime in the worker.
- **Secrets:** never commit `.env`; keep Compose files off public pastebins.

```bash
cp .env.example .env
# Set real GITHUB_*, WEBHOOK_SECRET, DATABASE_URL (if not using Compose defaults), and OPENAI_API_KEY (or keys for your PI_PROVIDER)
docker compose build
docker compose up
```

Compose sets `environment.PORT=7224` and **`7224:7224`** publishing so host and container ports match. For a host port clash, change **`ports`** to for example **`7227:7224`** and keep container **`PORT`** at **7224**.

**Requires Docker Engine with Compose v2** (CLI plugin). `env_file` defaults to **`.env`**; use host env **`PR_AGENT_ENV_FILE`** for an alternate path (variable substitution in the Compose file).

Alternate env file path (CI or smoke):

```bash
PR_AGENT_ENV_FILE=/abs/path/to/.env docker compose up
```

## Scripts

| Script                           | Purpose                            |
| -------------------------------- | ---------------------------------- |
| `pnpm dev`                       | Run `src/index.ts` (`ROLE` env)    |
| `pnpm build`                     | Compile to `dist/`                 |
| `pnpm start`                     | Run compiled `dist/`               |
| `pnpm typecheck`                 | `tsc --noEmit` (`src/` only)       |
| `pnpm lint`                      | Type-aware Oxlint                  |
| `pnpm lint:fix`                  | Oxlint with safe fixes             |
| `pnpm fmt`                       | Format with Oxfmt                  |
| `pnpm fmt:check`                 | Check formatting                   |
| `pnpm check:code`                | `typecheck` + `lint` + `fmt:check` |
| `pnpm run check:effect-versions` | Verify pinned Effect deps          |
| `pnpm test`                      | Vitest (`test/**/*.test.ts`)       |
| `pnpm test:watch`                | Vitest watch mode                  |

Type-aware lint requires `oxlint-tsgolint` (dev dependency). [`pnpm-workspace.yaml`](pnpm-workspace.yaml) sets `minimumReleaseAge: 10080` (7 days) for registry installs; `pg-cloudflare` is excluded as a fresh transitive dependency of `pg`.

## Security notes

- Treat `WEBHOOK_SECRET` and app private keys as production secrets.
- **`/ask`** applies deterministic outbound redaction (tokens, host URLs, PEM blocks) before posting replies; obvious bot-internals probes get an **Ask meta refusal** without an LLM call ([ADR 0010](docs/adr/0010-ask-red-team-hardening.md)). Review publish paths are unchanged.
- Structured logging uses [evlog](https://www.evlog.dev) with `service: pr-agent`; `LOG_LEVEL` maps to evlog `minLevel` (default `info`). At `info`, per-tool-round and rate-limit retry noise stays at `debug` and is omitted from emitted wide events.
- `LOG_MAX_WIDE_EVENTS` (default `128`) caps sub-events per webhook/worker operation. `LOG_PRETTY` defaults to off in production (JSON lines).
- Production logging should stay at `info` unless debugging a specific review run (`LOG_LEVEL=debug`).
