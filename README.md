# pr-agent

GitHub App webhook service that performs automated pull request reviews using native **Octokit** REST tools ([`src/agent/githubTools.ts`](src/agent/githubTools.ts)) and [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi/tree/main/packages/ai) (LLM + tool loop).

## What it does

- On **`pull_request`** (`opened`, `synchronize`, `reopened`), adds 👀 (`eyes`) on the PR issue, then runs an agent loop to inspect the PR and upsert **`## PR Agent Review`** on the PR conversation when the model succeeds. A pull request review on the Files tab (with inline P0–P2 threads) is posted only when those severities are present; its review pointer body includes a collapsible **agent fix prompt** aggregating all findings for copy-paste into coding agents.
- On **`issue_comment`** and **`pull_request_review_comment`** (`created` only), detects `/help`, `/ask`, `/review`, and `/review-security`, reacts with 👀 on the PR + triggering comment where applicable, and routes commands.
- Responds **`200`** after synchronous webhook handling finishes. Automated reviews and `/review` / `/review-security` block until the queued review run completes (large models can exceed GitHub’s webhook timeouts; tune `MAX_TOOL_ROUNDS`/model latency). **`/ask`** is acknowledged inline, then runs in a background fiber—the webhook returns before the answer is posted.

## Behaviour details

- **Payload boundary:** each subscribed `X-GitHub-Event` type is validated with **minimal Zod** shapes before deduplication; malformed payloads are logged and skipped without consuming the dedupe slot (so GitHub retries can succeed after fixes or transient issues).
- **Slash commands** are detected on the **first non-empty line** only, and are **case-sensitive** (`/review` works; `/Review` does not). `/ask <question>` answers one question about the PR or a specific diff line.
- **Webhook deduplication** uses `X-GitHub-Delivery` when present; if that header is missing, the server falls back to **SHA-256(raw body)** so identical retries still collapse.
- **Agent loop (reviews):** capped at **`MAX_TOOL_ROUNDS`** (tools required on the first round). If the conversation still ends on pending `toolResult` messages, up to **`MAX_FINALIZE_ROUNDS`** extra model turns run (tools may still be used). If **`submitReview`** never succeeds, publish-recovery nudges run up to **`MAX_REVIEW_PUBLISH_ATTEMPTS`**, then a plain-text fallback comment may be posted when structured publish is exhausted.
- **Review concurrency:** full review runs are bounded by **`REVIEW_CONCURRENCY`** (default `2`), enforced by an Effect `Semaphore` Layer (`ReviewQueue`), so bursts of webhook deliveries cannot start unbounded concurrent LLM/tool loops. Per-process (in-memory); multi-replica deployments are at-least-once.
- **GitHub tools:** eleven investigation tools plus two delivery-shaped tools are defined in [`src/agent/githubTools.ts`](src/agent/githubTools.ts); the agent cannot call `addPullRequestComment` or `createPullRequestReview`—the server publishes via `submitReview` instead (see [docs/adr/0004-native-pi-ai-toolset.md](docs/adr/0004-native-pi-ai-toolset.md)).
- **Library docs lookup:** review and ask agents get two Context7 tools (`resolveLibraryId`, `getLibraryDocs`) that hit `https://context7.com/api` to verify upstream API claims. Anonymous calls work for public libraries with rate limits; set **`CONTEXT7_API_KEY`** for higher limits and private repos. See [docs/adr/0003-context7-docs-tool.md](docs/adr/0003-context7-docs-tool.md).
- **Bot identity** for self-suppression is cached **per `GITHUB_APP_ID`**, so multiple GitHub Apps in one process do not share the same cache entry.
- **`/review-security`** — trigger-only deep security review (DeepSec-adapted prompt; see [NOTICES.md](NOTICES.md)). Never runs on `pull_request` webhooks. Uses the same `ReviewQueue` and `MAX_TOOL_ROUNDS` as `/review`; large PRs may need a higher `MAX_TOOL_ROUNDS`. Posts a separate summary comment (`## PR Agent Security Review`) that can coexist with the general review summary.
- **`/ask`** — interactive Q&A about PR code (PR conversation or inline diff comment). Uses a separate `AskQueue` (`ASK_CONCURRENCY`, default `3`) and `MAX_ASK_TOOL_ROUNDS` (default `12`). Inline replies are plain text; PR conversation replies repeat the question in a short wrapper. See [docs/adr/0008-ask-command.md](docs/adr/0008-ask-command.md).

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
corepack enable   # Node 22+ ships Corepack; activates pnpm from package.json
pnpm install
pnpm dev
```

Tunnel webhooks (e.g. [smee.io](https://smee.io)) to your local `PORT`, then point the GitHub App webhook at the smee URL forwarding to `/webhooks`.

### Runtime

- Runtime is Effect TS and is the only production boot path.
- Webhook handlers, PR-surface I/O (acknowledgement reactions, PR conversation / inline review thread comments, head SHA lookup), and the review and ask queues are Effect Layers (`WebhookHandlers`, `PrGithubSurface`, `ReviewQueue`, `AskQueue`). The dispatcher wires them together.

### Effect version gate

- `pnpm run check:effect-versions` enforces pinned versions:
  - `effect@3.21.2`
  - `@effect/platform@0.96.1`
  - `@effect/platform-node@0.106.0`
- `pnpm test` runs this version gate before Vitest (`pretest`).

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

## Scripts

| Script        | Purpose                |
|---------------|------------------------|
| `pnpm dev` | Run `src/index.ts`     |
| `pnpm build` | Compile to `dist/`   |
| `pnpm start`   | Run compiled `dist/`   |
| `pnpm typecheck` | `tsc --noEmit`   |
| `pnpm run check:effect-versions` | Verify pinned Effect deps |
| `pnpm test` | Vitest (`test/**/*.test.ts`) |
| `pnpm test:watch` | Vitest watch mode |

## Security notes

- Treat `WEBHOOK_SECRET` and app private keys as production secrets.
- The LLM is instructed not to paste secrets; there is **no** deterministic outbound redaction layer in v1.
- Production logging should stay at `info` or higher to avoid logging full payloads.
