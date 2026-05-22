# pr-agent

GitHub App webhook service that performs automated pull request reviews using native **Octokit** REST tools ([`src/agent/githubTools.ts`](src/agent/githubTools.ts)) and [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi/tree/main/packages/ai) (LLM + tool loop).

Durable agent work (Postgres intake + pg-boss workers) is described in [docs/adr/0009-durable-agent-work.md](docs/adr/0009-durable-agent-work.md). Operations runbooks: [docs/agent-work-ops.md](docs/agent-work-ops.md). Domain terms: [CONTEXT.md](CONTEXT.md).

## What it does

- On **`pull_request`** (`opened`, `synchronize`, `reopened`), enqueues an automated general review. A worker adds 👀 (`eyes`) on the PR issue, posts a progress stub, runs an agent loop, and upserts **`## PR Agent Review`** on the PR conversation when the model succeeds. A pull request review on the Files tab (with inline P0–P2 threads) is posted only when those severities are present; its review pointer body includes a collapsible **agent fix prompt** aggregating all findings for copy-paste into coding agents.
- On **`issue_comment`** and **`pull_request_review_comment`** (`created` only), detects `/help`, `/ask`, `/review`, and `/review-security`, enqueues work, and routes commands. Reactions and replies are published by workers, not on the webhook fiber.
- Responds **`200`** after **durable intake commits** to Postgres and pg-boss jobs are enqueued (or **`503`** if intake cannot commit — GitHub may redeliver). **Reactions, progress comments, reviews, and ask answers** run in **`ROLE=worker`** and may appear **seconds after** the HTTP response. The webhook does **not** wait for LLM runs to finish.

## Behaviour details

- **Payload boundary:** each subscribed `X-GitHub-Event` type is validated with **minimal Zod** shapes before deduplication; malformed payloads are logged and skipped **without** inserting a dedupe row (so GitHub retries can succeed after fixes or transient issues).
- **Slash commands** are detected on the **first non-empty line** only, and are **case-sensitive** (`/review` works; `/Review` does not). `/ask <question>` answers one question about the PR or a specific diff line.
- **Webhook deduplication** is **durable**: `webhook_events.dedupe_key` uses `X-GitHub-Delivery` when present, otherwise **SHA-256(raw body)**. Duplicate deliveries return **`200`** without creating duplicate work items.
- **Auto-review superseding:** on `pull_request` **`synchronize`**, newer automated general-lens work **supersedes** queued auto-reviews for the same PR and requests cooperative cancel on an in-flight auto-review (slash-command reviews are not superseded).
- **Agent loop (reviews):** capped at **`MAX_TOOL_ROUNDS`** (tools required on the first round). Each run is a **single-pass review**: one investigation sweep, then one **`submitReview`** with up to eight findings. If **`submitReview`** never succeeds, publish-recovery nudges run up to **`MAX_REVIEW_PUBLISH_ATTEMPTS`**, then a plain-text fallback comment may be posted when structured publish is exhausted.
- **Review pointer link:** on the second and later review runs per PR and lens, the Files-tab pointer links to the existing PR conversation summary comment when it can be verified; the first completed summary for that lens uses plain text only.
- **Worker concurrency:** review, ask, and acknowledgement jobs are capped per process by **`REVIEW_CONCURRENCY`** (default `2`), **`ASK_CONCURRENCY`** (default `1`), and **`ACK_CONCURRENCY`** (default `2`) via pg-boss worker `localConcurrency` ([`src/agentWork/worker.ts`](src/agentWork/worker.ts)). Multi-replica deployments remain **at-least-once** at the worker layer.
- **GitHub tools:** **11** investigation tools in [`src/agent/githubTools.ts`](src/agent/githubTools.ts), plus **2** Context7 doc tools; the server publishes only via **`submitReview`** (no agent-callable comment/review delivery tools). See [docs/adr/0004-native-pi-ai-toolset.md](docs/adr/0004-native-pi-ai-toolset.md).
- **Library docs lookup:** review and ask agents get two Context7 tools (`resolveLibraryId`, `getLibraryDocs`) that hit `https://context7.com/api` to verify upstream API claims. Anonymous calls work for public libraries with rate limits; set **`CONTEXT7_API_KEY`** for higher limits and private repos. See [docs/adr/0003-context7-docs-tool.md](docs/adr/0003-context7-docs-tool.md).
- **Bot identity** for self-suppression is cached **per `GITHUB_APP_ID`**, so multiple GitHub Apps in one process do not share the same cache entry.
- **`WEBHOOK_TIMEOUT_MS`** (default `10000`) is a **logging-only** budget on webhook intake duration; it does not cancel worker jobs.
- **`/review-security`** — trigger-only deep security review (DeepSec-adapted prompt; see [NOTICES.md](NOTICES.md)). Never runs on `pull_request` webhooks. Uses the same review worker lane and **`MAX_TOOL_ROUNDS`** as `/review`; large PRs may need a higher `MAX_TOOL_ROUNDS`. Posts a separate summary comment (`## PR Agent Security Review`) that can coexist with the general review summary.
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
cp .env.example .env         # GITHUB_*, WEBHOOK_SECRET, DATABASE_URL, provider keys
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
- **Worker:** [`AgentWorkerRuntimeLive`](src/agentWork/runtime.ts) consumes acknowledgement, review, and ask queues.
- **Legacy (tests only):** [`slashCommandFlow`](src/commands/slashCommandFlow.ts), [`ReviewQueue`](src/effect/services/reviewQueue.ts), and [`AskQueue`](src/effect/services/askQueue.ts) are **not** wired into the production webhook dispatcher; they remain for unit tests of slash handling and in-process concurrency caps.

### Effect version gate

- `pnpm run check:effect-versions` enforces pinned versions:
  - `effect@3.21.2`
  - `@effect/platform@0.96.1`
  - `@effect/platform-node@0.106.0`
- `pnpm test` runs this version gate before Vitest (`pretest`).

## Docker and Docker Compose

- **Stack:** [docker-compose.yml](docker-compose.yml) runs **`postgres`**, **`pr-agent-web`** (`ROLE=web`), and **`pr-agent-worker`** (`ROLE=worker`). `docker compose up` is required for end-to-end reviews and asks; web-only is not sufficient.
- **Image:** multi-stage `Dockerfile` (Node 22); runtime listens on **`PORT`** (pinned to **7224** in Compose and [`.env.example`](.env.example)).
- **Health:** `GET /health` returns `200` and plain `ok` (used by `HEALTHCHECK` in the image and by Compose).
- **Webhook URL** (when Compose maps default ports): **`http://<host>:7224/webhooks`** — same path as bare Node.
- **`DATABASE_URL`** is set in Compose for both app services (`postgres://pr_agent:pr_agent@postgres:5432/pr_agent`).
- **Provider API keys** (for example **`OPENAI_API_KEY`**) are **not** read by [`src/config.ts`](src/config.ts); Pi AI loads them from the environment. Set them in `.env` beside the GitHub fields or reviews fail at runtime in the worker.
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
