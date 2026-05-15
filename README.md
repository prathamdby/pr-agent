# pr-agent

GitHub App webhook service that performs automated pull request reviews using [`@github-tools/sdk`](https://github.com/vercel-labs/github-tools) (GitHub REST as tools) + [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi/tree/main/packages/ai) (LLM + tool loop), per the tracked plan document.

## What it does

- On **`pull_request`** (`opened`, `synchronize`, `reopened`), adds 👀 (`eyes`) on the PR issue, then runs an agent loop to inspect the PR and post a **`COMMENT`**-style GitHub review plus a timeline summary comment when the model succeeds.
- On **`issue_comment`** and **`pull_request_review_comment`** (`created` only), detects `/help` and `/review`, reacts with 👀 on the PR + triggering comment where applicable, and routes commands.
- Responds **`200`** only **after inline processing completes** — large models can exceed GitHub’s webhook timeouts; operators should tune `MAX_TOOL_ROUNDS`/model latency or revisit async delivery (tracked as a scaling concern in the plan).

## Behaviour details

- **Payload boundary:** each subscribed `X-GitHub-Event` type is validated with **minimal Zod** shapes before deduplication; malformed payloads are logged and skipped without consuming the dedupe slot (so GitHub retries can succeed after fixes or transient issues).
- **Slash commands** are detected on the **first non-empty line** only, and are **case-sensitive** (`/review` works; `/Review` does not).
- **Webhook deduplication** uses `X-GitHub-Delivery` when present; if that header is missing, the server falls back to **SHA-256(raw body)** so identical retries still collapse.
- **Agent loop:** after the main `MAX_TOOL_ROUNDS` limit, the service runs up to **`MAX_FINALIZE_ROUNDS`** additional model turns if the conversation still ends with pending `toolResult` messages, then—if still stuck—forces one **text-only** completion (tools cleared) so the webhook does not end with an unfinished tool chain.
- **Upstream tools:** `@github-tools/sdk` targets the Vercel AI ecosystem; errors mentioning workflow/durable/approval may mean a tool is not viable in plain Node—check logs; you may need fewer presets or direct REST for that action.
- **Bot identity** for self-suppression is cached **per `GITHUB_APP_ID`**, so multiple GitHub Apps in one process do not share the same cache entry.

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
| `npm run test` | Vitest (`test/**/*.test.ts`) |
| `npm run test:watch` | Vitest watch mode |

## Security notes

- Treat `WEBHOOK_SECRET` and app private keys as production secrets.
- The LLM is instructed not to paste secrets; there is **no** deterministic outbound redaction layer in v1 (see plan).
- Production logging should stay at `info` or higher to avoid logging full payloads (see plan).
