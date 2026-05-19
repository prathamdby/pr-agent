# pr-agent

GitHub App webhook service that performs automated pull request reviews using [`@github-tools/sdk`](https://github.com/vercel-labs/github-tools) (GitHub REST as tools) + [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi/tree/main/packages/ai) (LLM + tool loop), per the tracked plan document.

## What it does

- On **`pull_request`** (`opened`, `synchronize`, `reopened`), adds 👀 (`eyes`) on the PR issue, then runs an agent loop to inspect the PR and upsert **`## PR Agent Review`** on the PR conversation when the model succeeds. A pull request review on the Files tab (with inline P0–P2 threads) is posted only when those severities are present.
- On **`issue_comment`** and **`pull_request_review_comment`** (`created` only), detects `/help`, `/review`, and `/review-security`, reacts with 👀 on the PR + triggering comment where applicable, and routes commands.
- Responds **`200`** only **after inline processing completes** — large models can exceed GitHub’s webhook timeouts; operators should tune `MAX_TOOL_ROUNDS`/model latency or revisit async delivery (tracked as a scaling concern in the plan).

## Behaviour details

- **Payload boundary:** each subscribed `X-GitHub-Event` type is validated with **minimal Zod** shapes before deduplication; malformed payloads are logged and skipped without consuming the dedupe slot (so GitHub retries can succeed after fixes or transient issues).
- **Slash commands** are detected on the **first non-empty line** only, and are **case-sensitive** (`/review` works; `/Review` does not).
- **Webhook deduplication** uses `X-GitHub-Delivery` when present; if that header is missing, the server falls back to **SHA-256(raw body)** so identical retries still collapse.
- **Agent loop:** after the main `MAX_TOOL_ROUNDS` limit, the service runs up to **`MAX_FINALIZE_ROUNDS`** additional model turns if the conversation still ends with pending `toolResult` messages, then—if still stuck—forces one **text-only** completion (tools cleared) so the webhook does not end with an unfinished tool chain.
- **Review concurrency:** full review runs are bounded by **`REVIEW_CONCURRENCY`** (default `2`), enforced by an Effect `Semaphore` Layer (`ReviewQueue`), so bursts of webhook deliveries cannot start unbounded concurrent LLM/tool loops. Per-process (in-memory); multi-replica deployments are at-least-once.
- **Upstream tools:** `@github-tools/sdk` targets the Vercel AI ecosystem; errors mentioning workflow/durable/approval may mean a tool is not viable in plain Node—check logs; you may need fewer presets or direct REST for that action.
- **Library docs lookup:** the review agent also gets two Context7 tools (`resolveLibraryId`, `getLibraryDocs`) that hit `https://context7.com/api` to verify upstream API claims before flagging findings. Anonymous calls work for public libraries with rate limits; set **`CONTEXT7_API_KEY`** for higher limits and private repos. See [docs/adr/0003-context7-docs-tool.md](docs/adr/0003-context7-docs-tool.md) for why the SDK is bypassed.
- **Bot identity** for self-suppression is cached **per `GITHUB_APP_ID`**, so multiple GitHub Apps in one process do not share the same cache entry.
- **`/review-security`** — trigger-only deep security review (DeepSec-adapted prompt; see [NOTICES.md](NOTICES.md)). Never runs on `pull_request` webhooks. Uses the same `ReviewQueue` and `MAX_TOOL_ROUNDS` as `/review`; large PRs may need a higher `MAX_TOOL_ROUNDS`. Posts a separate summary comment (`## PR Agent Security Review`) that can coexist with the general review summary.

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

```bash
cp .env.example .env
# fill secrets
npm install
npm run dev
```

Tunnel webhooks (e.g. [smee.io](https://smee.io)) to your local `PORT`, then point the GitHub App webhook at the smee URL forwarding to `/webhooks`.

### Runtime

- Runtime is Effect TS by default and is the only production boot path.
- Webhook handlers, PR-surface I/O (acknowledgement reactions, PR conversation / inline review thread comments, head SHA lookup), and the review queue are all Effect Layers (`WebhookHandlers`, `PrGithubSurface`, `ReviewQueue`). The dispatcher wires them together; no Promise glue at the seams.

### Effect version gate

- `npm run check:effect-versions` enforces pinned rewrite compatibility versions:
  - `effect@3.21.2`
  - `@effect/platform@0.96.1`
  - `@effect/platform-node@0.106.0`
- `npm test` now runs this version gate before Vitest.

## Docker and Docker Compose

- **Image:** multi-stage `Dockerfile` (Node 22); runtime listens on **`PORT`** (pinned to **7224** in [docker-compose.yml](docker-compose.yml) and [`.env.example`](.env.example)).
- **Health:** `GET /health` returns `200` and plain `ok` (used by `HEALTHCHECK` in the image and by Compose).
- **Webhook URL** (when Compose maps default ports): **`http://<host>:7224/webhooks`** — same path as bare Node.
- **Provider API keys** (for example **`OPENAI_API_KEY`**) are **not** read by [`src/config.ts`](src/config.ts); Pi AI loads them from the environment. Set them in `.env` beside the GitHub fields or the container will boot but **`/review`** and automated reviews fail at runtime.
- **Secrets:** never commit `.env`; keep Compose files off public pastebins.

```bash
cp .env.example .env
# Set real GITHUB_* , WEBHOOK_SECRET , and OPENAI_API_KEY (or keys for your PI_PROVIDER )
docker compose build
docker compose up
```

Compose sets `environment.PORT=7224` and **`7224:7224`** publishing so host and container ports match. For a host port clash, change **`ports`** to for example **`7227:7224`** and keep container **`PORT`** at **7224**.

**Requires Docker Engine with Compose v2** (CLI plugin). `env_file` defaults to **`.env`**; use host env **`PR_AGENT_ENV_FILE`** for an alternate path (variable substitution in the Compose file).

Alternate env file path (CI or smoke):

```bash
PR_AGENT_ENV_FILE=/abs/path/to/.env docker compose up
```

## BTCA reference clones

For exploring upstream tool shapes locally, use `~/.btca/agent/sandbox` with clones of `vercel-labs/github-tools` and `earendil-works/pi` (see project plan).

## Scripts

| Script        | Purpose                |
|---------------|------------------------|
| `npm run dev` | Run `src/index.ts`     |
| `npm run build` | Compile to `dist/`   |
| `npm start`   | Run compiled `dist/`   |
| `npm run typecheck` | `tsc --noEmit`   |
| `npm run check:effect-versions` | Verify pinned Effect deps |
| `npm run test` | Vitest (`test/**/*.test.ts`) |
| `npm run test:watch` | Vitest watch mode |

## Security notes

- Treat `WEBHOOK_SECRET` and app private keys as production secrets.
- The LLM is instructed not to paste secrets; there is **no** deterministic outbound redaction layer in v1 (see plan).
- Production logging should stay at `info` or higher to avoid logging full payloads (see plan).
