[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/prathamdby/pr-agent)

# PR Agent

Self-hosted GitHub App for AI pull request reviews.

PR Agent installs on your GitHub org or repos, receives webhooks, and runs reviews on machines you operate. Optional work includes describe, ask, triage, and verification. You bring the GitHub App credentials, a Postgres database, and an LLM API key.

Two processes must run together. **web** accepts signed webhooks, writes work to Postgres, and enqueues jobs. It returns `200` once that write succeeds. **worker** runs the queues: reactions, progress comments, model sessions, and everything posted back to the PR. If only web is up, nothing appears on the PR.

## Contents

- [Functions](#functions)
- [Installation](#installation)
- [Verification](#verification)
- [Maintainer](#maintainer)
- [Examples](#examples)
- [How it works](#how-it-works)
- [Local development](#local-development)
- [Data privacy](#data-privacy)
- [Documentation](#documentation)

## Functions

Defaults match [`.env.example`](.env.example) and [docs/features.md](docs/features.md).

| Function            | When it runs                                      | Command                         |
| ------------------- | ------------------------------------------------- | ------------------------------- |
| Orchestrated review | PR `opened` when `FEATURE_REVIEW=auto`            | `/review` always                |
| PR description      | PR `opened` when `FEATURE_DESCRIBE=auto`          | `/describe`                     |
| Verification        | PR `synchronize` when `FEATURE_VERIFICATION=auto` | `/verify`                       |
| Ask                 | On demand when `FEATURE_ASK=manual`               | `/ask …` or mention the App bot |
| Triage autofix      | On demand when `FEATURE_TRIAGE=manual`            | `/triage`                       |
| Cancel review       | On demand                                         | `/cancel`                       |
| Restart review      | On demand (cancels the active run, latest commit) | `/review force`                 |
| Help                | On demand                                         | `/help`                         |

Review runs four specialists (correctness, security, quality, tests) under one orchestrator and posts one `## PR Agent Review` summary. A finding is published only when it meets the causal-publication contract. The orchestrator re-applies that contract during judgment. P0-P2 findings fail the review check run. P3 does not. Docs-only trivial PRs can take a short auto path instead of a full orchestrated run ([ADR 0010](docs/adr/0010-lightweight-review-completion.md)).

Slash commands are case-sensitive. The command must be the first non-empty line of a **new** (`created`) comment. Who may run them is controlled by `SLASH_ALLOWED_ASSOCIATIONS` (default `OWNER,MEMBER,COLLABORATOR`). Mention matching uses the App bot login, not the word `@bot`. `/ask` and `/help` do not need a mention.

Optional labels, commit status, and title rewrite are separate `FEATURE_*` flags. Set `FEATURE_DESCRIBE=off`, `FEATURE_ASK=off`, and similar when you want those features to stop calling the model. `FEATURE_REVIEW` accepts only `manual` or `auto`. `off` crashes startup.

## Installation

You need Docker Engine with Compose v2, a GitHub account that can create a GitHub App, one AI provider key, and a host GitHub can reach over HTTPS. A laptop can use a tunnel client instead of public TLS.

Create the GitHub App and paste a real private key before you start Compose. The example key in `.env.example` is not a real key. Both app containers exit if you start them without a generated App key.

### 1. Register the GitHub App

1. Open [Register a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app).
2. Set **Homepage URL** to this repository (`https://github.com/prathamdby/pr-agent`) or your public site. The form requires it. The App does not use it at runtime.
3. Leave **Identifying and authorizing users** off. Do not set a callback URL. This App does not use user login.
4. Set **Webhook URL** to `https://<your-host>/webhooks` once you have HTTPS, or a tunnel URL that forwards to `/webhooks`. You can save the App first and add the URL after the host is up.
5. Set **Webhook secret** now. Copy the same value into `WEBHOOK_SECRET` later.
6. Subscribe to these repository events (and only these for a normal install):
   - `pull_request`
   - `issue_comment`
   - `pull_request_review_comment`
   - `workflow_run` and `check_suite` (either completed event refreshes the CI row on an existing review summary when Actions finish later)
7. Do not require `pull_request_review` unless you have a reason. The bot does not need it for normal intake.
8. Repository permissions:

   | Permission      | Access       | Why                                               |
   | --------------- | ------------ | ------------------------------------------------- |
   | Issues          | Read & write | PR conversation comments and reactions            |
   | Pull requests   | Read & write | Reviews, inline threads, PR body for `/describe`  |
   | Contents        | Read & write | Read code; write only needed for `/triage` pushes |
   | Metadata        | Read         | Required by GitHub for apps                       |
   | Checks          | Read & write | Review check run + CI summary inputs              |
   | Actions         | Read         | Condensed job logs when CI fails                  |
   | Commit statuses | Read & write | Only if you set `FEATURE_COMMIT_STATUS=true`      |

9. Create the app, generate a **private key**, and copy the **App ID**.
10. Install the app on the orgs or repos you want reviewed. Creating the App is not enough. Deliveries need an installation. If you pick **Only select repositories**, include the test repo. Skip install and the worker cannot mint a token.

### 2. Create the environment file

```bash
git clone https://github.com/prathamdby/pr-agent.git
cd pr-agent
cp .env.example .env
```

Edit `.env` and set at least:

```bash
GITHUB_APP_ID=...
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
WEBHOOK_SECRET=replace-with-a-strong-secret
PI_PROVIDER=openai
PI_MODEL=gpt-4o-mini
OPENAI_API_KEY=sk-...
```

Notes:

- Paste the GitHub App private key as one line with `\n` for newlines, or as base64-encoded PEM. Compose `env_file` is line-oriented. A literal multi-line PEM block is the form most likely to break parsing. The process accepts real newlines, escaped `\n`, or base64 once the value reaches it. A placeholder or truncated PEM stops both app containers.
- `WEBHOOK_SECRET` must match the secret you set on the GitHub App.
- Compose overrides `ROLE` and `DATABASE_URL` for each service. Web and worker use hostname `postgres` on the compose network. The `DATABASE_URL` in `.env.example` (`localhost:5432`) is for host processes only, and only after you publish Postgres. See [Local development](#local-development).
- Leave `OPENAI_API_KEY` empty and the process still starts. Reviews then fail later on the worker. Set the provider key before you expect a review to post.
- Default HTTP port is `7224` (Compose and `.env.example`). Bare `nub src/index.ts` without `PORT` falls back to `3000`.
- `.env.example` sets `LOG_PRETTY=true` for a laptop. On a public host, set `LOG_PRETTY=false` or drop the line so production defaults apply. Change the default Postgres password if the host is reachable.

Full env catalog: [docs/configuration.md](docs/configuration.md). Feature switches: [docs/features.md](docs/features.md).

### 3. Start the stack

```bash
docker compose build
docker compose up -d
```

That starts three services from [docker-compose.yml](docker-compose.yml):

| Service           | Role          | What it does                                                                                                     |
| ----------------- | ------------- | ---------------------------------------------------------------------------------------------------------------- |
| `postgres`        | database      | Durable webhook dedupe, work items, pg-boss jobs. Not published to the host.                                     |
| `pr-agent-web`    | `ROLE=web`    | `POST /webhooks`, `GET /health`, `GET /ready` on port `7224`                                                     |
| `pr-agent-worker` | `ROLE=worker` | Consumes ack, review, ask, description, triage, verification, CI-refresh, code-index-build, and retention queues |

Migrations run automatically when each process opens its Postgres pool. You do not run them by hand.

```bash
# optional: different env file path
PR_AGENT_ENV_FILE=/abs/path/to/.env docker compose up -d
```

If host port `7224` is taken, map another host port and keep the container on `7224`:

```yaml
# under pr-agent-web in a compose override
ports:
  - "7227:7224"
```

Do not start [docker-compose.prod.yml](docker-compose.prod.yml) with the example `DATABASE_URL`. That overlay replaces the in-compose `postgres` hostname with `${DATABASE_URL}`. Inside the container, `localhost` is the app container, not the database. The overlay also requires `POSTGRES_DB`, `POSTGRES_USER`, and `POSTGRES_PASSWORD`. Details: [docs/operations.md](docs/operations.md).

If you change GitHub fields after the first start, recreate the app containers:

```bash
docker compose up -d --force-recreate pr-agent-web pr-agent-worker
```

### 4. Reach the webhook

GitHub must reach `POST /webhooks` on the web service over HTTPS. Localhost is the documented exception. Compose publishes HTTP `7224` only. There is no Caddy, nginx, or certificate in this repo. TLS is operator-owned.

- **Production:** put TLS in front of `pr-agent-web` (Caddy, nginx, a load balancer, your PaaS). Forward to container port `7224`. A minimal Caddy example lives in [docs/operations.md](docs/operations.md#tls-in-front-of-compose).
- **Laptop test:** start a tunnel client that forwards to `http://127.0.0.1:7224/webhooks`. Set the GitHub App webhook to that public URL. A smee channel or Cloudflare hostname with no local client drops every delivery. GitHub can show 200 from the relay while this process sees nothing.

smee.io:

```bash
# create a channel at https://smee.io, then:
npx smee-client -u https://smee.io/<channel> --target http://127.0.0.1:7224/webhooks
```

Cloudflare Tunnel:

```bash
cloudflared tunnel --url http://127.0.0.1:7224
```

Then set the App webhook to `https://<trycloudflare-host>/webhooks`.

Webhook handler path is always `/webhooks`.

### 5. Set the model provider

LLM calls run on the **worker** only, through the Pi Core session runtime ([ADR 0023](docs/adr/0023-pi-native-agent-runtime.md)).

| What                    | Env vars                                            | Used for                                                               |
| ----------------------- | --------------------------------------------------- | ---------------------------------------------------------------------- |
| General primary         | `PI_PROVIDER`, `PI_MODEL`                           | Specialists, ask, describe, triage, verification, CI-summary authoring |
| Orchestrator (optional) | `PI_ORCHESTRATOR_PROVIDER`, `PI_ORCHESTRATOR_MODEL` | Review orchestrator session; empty means inherit general primary       |
| Fallback (optional)     | `PI_FALLBACK_PROVIDER`, `PI_FALLBACK_MODEL`         | Second attempt onward via retry escalation; both must be set to enable |

Minimal OpenAI example:

```bash
PI_PROVIDER=openai
PI_MODEL=gpt-4o-mini
OPENAI_API_KEY=sk-...
```

- Without a catalog, worker boot only checks that `PI_PROVIDER` is a builtin. An unknown `PI_MODEL` falls through to that provider's first model API type. The first session then throws `provider.model_not_found`. Web never validates the model id. A present `models.json` does fail worker boot on a missing selection.
- pr-agent loads `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `GOOGLE_GENERATIVE_AI_API_KEY` in [`src/config.ts`](src/config.ts). If the Google alias is empty, pi-ai also reads `GEMINI_API_KEY` from the process environment. Other Pi providers use their usual env vars on the worker (for example `DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`). Provider catalog: [pi-ai](https://github.com/earendil-works/pi/tree/main/packages/ai).
- Optional custom catalog: copy [`models.json.example`](models.json.example), place `models.json` at the repo root before `docker build` (copied to `/app/models.json` when present), add a runtime mount on **both** web and worker (the committed compose file does not), or set `MODELS_JSON_PATH`. Details: [docs/operations.md](docs/operations.md).

Restart the worker after provider changes:

```bash
docker compose up -d --force-recreate pr-agent-worker
```

## Verification

This is the smallest check that the install actually runs.

```bash
curl -sS http://127.0.0.1:7224/health   # ok
curl -sS http://127.0.0.1:7224/ready    # ready (web: Postgres up)
```

Those probes do not prove GitHub can reach `/webhooks`, that the worker has a provider key, or that App permissions match what publish code calls. An empty `OPENAI_API_KEY` still boots. Confirm the provider secret in `.env` before you open a PR.

Worker readiness (consumers registered + Postgres/pg-boss) is checked inside the Compose healthcheck on the worker container (`GET /ready`). The image `HEALTHCHECK` hits `/health`, which is process liveness only. Compose overrides the worker check. From the host you only published the web port by default.

Then open a small PR on an **installed** repo. Comment `/help` only from an account in `SLASH_ALLOWED_ASSOCIATIONS` (default `OWNER,MEMBER,COLLABORATOR`). A contributor or outside commenter gets webhook `200` and no reply. That looks like a dead worker.

| Expect                                      | Where                                      |
| ------------------------------------------- | ------------------------------------------ |
| Eyes reaction soon after intake             | PR or triggering comment                   |
| `## PR Agent Review` progress comment       | PR conversation (auto review or `/review`) |
| Inline findings on the Files tab            | When the bot can anchor them               |
| Final summary replaces the progress comment | Same conversation comment                  |

If webhooks return 200 but the PR stays quiet, check the worker logs, the provider key, App install (not just App create), slash allowlist, and the queue runbook: [docs/agent-work-ops.md](docs/agent-work-ops.md). `docker compose logs -f pr-agent-worker`.

Default `FEATURE_VERIFICATION=auto` spends tokens on every push. Switch it to `manual` or `off` if that bill is too high.

## Maintainer

[Pratham](https://github.com/prathamdby) runs this App on all of his repositories, with every feature left on.

Primary provider is [OpenCode Go](https://opencode.ai/go?ref=AHE1W13AS7) ($10 AI subscription). Model is Meta Muse Spark 1.3 Contributor.

[![OpenCode Go](https://img.shields.io/badge/OpenCode-Go-111111)](https://opencode.ai/go?ref=AHE1W13AS7)

That is his operator setup. The install path above still uses the Pi provider env vars (`PI_PROVIDER`, `PI_MODEL`, and the matching API key). This repo does not add a second runtime for OpenCode Go.

## Examples

<details>
  <summary><h3>/describe</h3></summary>
  <img src="site/public/screenshots/describe.example.webp" alt="Example /describe output showing PR Agent Description block" width="800" />
</details>

<details>
  <summary><h3>/review</h3></summary>
  <img src="site/public/screenshots/review.example.webp" alt="Example /review output showing PR Agent Review summary" width="800" />
</details>

<details>
  <summary><h3>/ask</h3></summary>
  <img src="site/public/screenshots/ask.example.webp" alt="Example /ask answer on a pull request" width="800" />
</details>

## How it works

```mermaid
flowchart LR
  GitHub[GitHub webhooks] --> Web["ROLE=web /webhooks"]
  Web --> Dedupe[Postgres webhook_events + body replay]
  Dedupe --> Items[agent_work_items]
  Items --> Boss[pg-boss enqueue]
  Boss --> AckQ[ack queue]
  Boss --> CiRefQ[ci-refresh queue]
  Boss --> RevQ[review queue]
  Boss --> AskQ[ask queue]
  Boss --> DescQ[description queue]
  Boss --> TriageQ[triage queue]
  Boss --> VerifQ[verification queue]
  Boss --> RetQ[retention queue]
  Boss --> CodeIdxQ[code-index-build queue]
  AckQ --> Worker["ROLE=worker executors"]
  CiRefQ --> Worker
  RevQ --> Worker
  AskQ --> Worker
  DescQ --> Worker
  TriageQ --> Worker
  VerifQ --> Worker
  RetQ --> Worker
  CodeIdxQ --> Worker
  Worker --> Retention[retention cleanup]
  Retention --> Dedupe
  Retention --> Items
  RevQ --> ReviewExec[Review executor]
  ReviewExec --> Orchestrator[Review orchestrator]
  Orchestrator --> Correctness[Correctness specialist]
  Orchestrator --> Security[Security specialist]
  Orchestrator --> Quality[Quality specialist]
  Orchestrator --> Tests[Tests specialist]
  Correctness --> Orchestrator
  Security --> Orchestrator
  Quality --> Orchestrator
  Tests --> Orchestrator
  Orchestrator --> Publish[GitHub PR-surface publish]
  Worker --> Push[git push PR branch]
```

1. **Web** ([`processWebhookRequestEffect`](src/effect/programs/processWebhookRequestEffect.ts)) verifies the signature, parses the payload, applies delivery-ID and body-hash replay protection in Postgres, and schedules work. It does not create installation tokens or post to the PR.
2. **Scheduler** ([`AgentWorkScheduler`](src/agentWork/scheduler.ts)) admits asks through durable actor, repository, installation, outstanding-work, and provider-budget state, then inserts `agent_work_items` and enqueues pg-boss jobs.
3. **Ack worker** posts the eyes reaction and the review progress stub. **CI-refresh worker** updates only the CI cell on a finished summary when `workflow_run` or `check_suite` completes later.
4. **Worker** ([`AgentWorkerLive`](src/agentWork/worker.ts)) owns queue consumers, pg-boss supervision, and the daily retention sweep. One active run per PR per work type is enforced by the `pr_actor_leases` table ([ADR 0030](docs/adr/0030-pr-actor-lease.md)), not by queue policy, so a crashed worker's run is taken over once its lease lapses. Ask quota reservations release from terminal work-item transitions ([ADR 0031](docs/adr/0031-ask-admission-quotas.md)).
5. **Feature executors** ([`src/agentWork/executors/`](src/agentWork/executors/)) create a GitHub installation token, open a local PR workspace (or a writable checkout for triage), run the agent, and publish through the epoch- and cancellation-fenced `PrSurface` mutation boundary for leased work; ask remains unleased.
6. **Reviews** ([`runOrchestratedPrReview`](src/review/orchestrator/orchestratorRun.ts)) inspect the PR, write a specialist brief, run four specialists in parallel, publish inline thread batches, then write the final summary.

Queue inspection and recovery: [docs/agent-work-ops.md](docs/agent-work-ops.md). Design background: [ADR 0006](docs/adr/0006-durable-agent-work.md), [ADR 0005](docs/adr/0005-ask-command.md).

## Local development

Use this when you are changing the code. For production hosting, use [Installation](#installation).

`DATABASE_URL` is required for both roles ([`src/config.ts`](src/config.ts)).

```bash
# Compose postgres is not published to the host. Use a published container for host processes:
docker run -d --name pr-agent-postgres \
  -e POSTGRES_DB=pr_agent -e POSTGRES_USER=pr_agent -e POSTGRES_PASSWORD=pr_agent \
  -p 5432:5432 postgres:16-alpine

cp .env.example .env
# fill a real GitHub App PEM + provider fields
# DATABASE_URL=postgres://pr_agent:pr_agent@localhost:5432/pr_agent

npm install -g --ignore-scripts=false @nubjs/nub@0.7.2
nub install

# Nub loads PORT from .env (7224). Give each role its own port.
# terminal 1: webhook intake only
PORT=3000 ROLE=web nub src/index.ts

# terminal 2: all queue consumers
PORT=3001 ROLE=worker nub src/index.ts
```

`nub src/index.ts` loads `.env` automatically. Auto-restart: `nub watch src/index.ts`. Tunnel webhooks to `/webhooks` on the web `PORT`. Pin Nub to `0.7.2` (`package.json` `packageManager`, `Dockerfile`, `site/vercel.json`). Compose deploy does not need a host Nub install.

`docker compose up -d postgres` alone does not open host port `5432`. Full `docker compose up` works because web and worker get `DATABASE_URL` rewritten to `@postgres:5432`.

If you previously installed with pnpm or npm at the repo root, delete `node_modules` before the first `nub install` so the virtual store is not mixed (`.pnpm/` vs Nub’s store).

```bash
# unit tests (no database)
nub run test

# integration tests (needs a published Postgres, not unpublished compose postgres)
DATABASE_URL=postgres://pr_agent:pr_agent@localhost:5432/pr_agent nub run test:integration

# typecheck + lint + format
nub run check:code
```

Vitest does not load `.env` for you. Export `DATABASE_URL` in the shell for integration runs. Inventory-only suite that may skip DB cases: `nub run test:integration:inventory`.

More scripts and edge cases: [docs/operations.md](docs/operations.md#development), [docs/cursor-cloud.md](docs/cursor-cloud.md).

The marketing site under `site/` is a separate workspace package (`pr-agent-landing`). It is not required to run the bot. The human page is a short overview. Agents should read `/llms.txt` or `/agents.md`, query `GET /llms?query=` / `GET /llms/json?query=`, and can fetch the page itself as markdown from `/index.md` or by sending `Accept: text/markdown` to `/`. Every endpoint is described in `/openapi.json`.

## Data privacy

**Self-hosted.** Postgres, pg-boss, webhook bodies, and work-item state stay on your infrastructure. You own the GitHub App credentials.

**LLM providers.** Review, description, ask, triage, verification, and CI-summary text leave your network only when the worker calls your configured provider (`PI_PROVIDER` / `PI_MODEL`). Read that provider's data policy (example: [OpenAI](https://openai.com/enterprise-privacy)).

**Context7 (optional).** Library lookup uses the fixed `https://context7.com/api` endpoint. Requests accept only short library identifiers and documentation questions; source, prompts, comments, credentials, URLs, and tool output are rejected before transmission. `CONTEXT7_API_KEY`, when set, is sent only as an `Authorization` header; empty keys use anonymous fallback.

**Logging.** Structured logs use [evlog](https://www.evlog.dev) on your hosts. `LOG_REDACT` defaults to true and strips secret-shaped substrings. AppError messages, contexts, raw values, causes, arrays, objects, and circular references are recursively sanitized at log and analytics boundaries; safe codes and identifiers remain available. See [the telemetry redaction policy](docs/operations.md#security).

**Ask safety.** `/ask` applies outbound redaction before posting. Questions aimed at bot internals can get a short refusal without an LLM call ([ADR 0007](docs/adr/0007-ask-red-team-hardening.md)).

More security detail: [docs/operations.md](docs/operations.md#security).

## Documentation

| Document                                             | What it covers                         |
| ---------------------------------------------------- | -------------------------------------- |
| [DeepWiki](https://deepwiki.com/prathamdby/pr-agent) | Ask questions against this repository  |
| [Features](docs/features.md)                         | `FEATURE_*` modes and slash commands   |
| [Configuration](docs/configuration.md)               | Env vars, defaults, and code constants |
| [Operations](docs/operations.md)                     | TLS, scripts, production overlay       |
| [Queue runbook](docs/agent-work-ops.md)              | Inspect and recover durable work       |
| [Development](docs/development.md)                   | Module layout and import rules         |
| [Cursor Cloud](docs/cursor-cloud.md)                 | Cloud VM services                      |
| [Domain terms](CONTEXT.md)                           | Product vocabulary                     |
| [ADRs](docs/adr/)                                    | Architecture decisions                 |
