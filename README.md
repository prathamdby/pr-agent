<div align="center">

# PR Agent

Self-hosted GitHub App for AI pull request reviews

`pr-agent` · Node 22+ · Postgres · pg-boss

</div>

PR Agent installs on your GitHub org or repos, receives webhooks, and runs reviews (plus optional describe, ask, triage, and verification) on your own machines. You bring the GitHub App credentials, a Postgres database, and an LLM API key.

Two processes must run together:

1. **web** accepts signed webhooks, writes work to Postgres, and enqueues jobs. It returns `200` once that write succeeds.
2. **worker** runs the queues: reactions, progress comments, model sessions, and everything posted back to the PR.

If only web is up, nothing appears on the PR. Comments and reviews show up a few seconds later once a worker picks up the job.

Deeper docs: [features](docs/features.md) · [configuration](docs/configuration.md) · [operations](docs/operations.md) · [queue runbook](docs/agent-work-ops.md) · [domain terms](CONTEXT.md)

---

## Table of contents

- [Host with Docker Compose](#host-with-docker-compose)
- [Create the GitHub App](#create-the-github-app)
- [Point GitHub at your server](#point-github-at-your-server)
- [Choose an LLM provider](#choose-an-llm-provider)
- [Check that it works](#check-that-it-works)
- [What you get](#what-you-get)
- [See it in action](#see-it-in-action)
- [How it works](#how-it-works)
- [Local development](#local-development)
- [Data privacy](#data-privacy)

## Host with Docker Compose

You need Docker Engine with Compose v2, a host that GitHub can reach over HTTPS (or a tunnel while testing), and about 15 minutes.

### 1. Clone and create `.env`

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

- Paste the GitHub App private key as one line with `\n` for newlines, as real multi-line PEM, or as base64-encoded PEM. Config loading accepts all three.
- `WEBHOOK_SECRET` must match the secret you set on the GitHub App.
- Compose overrides `ROLE` and `DATABASE_URL` for each service. You still need the GitHub and provider fields in `.env`.
- Default HTTP port is `7224` (Compose and `.env.example`). Bare `nub src/index.ts` without `PORT` falls back to `3000`.

Full env catalog: [docs/configuration.md](docs/configuration.md). Feature switches: [docs/features.md](docs/features.md).

### 2. Start the stack

```bash
docker compose build
docker compose up -d
```

That starts three services from [docker-compose.yml](docker-compose.yml):

| Service           | Role          | What it does                                                                                   |
| ----------------- | ------------- | ---------------------------------------------------------------------------------------------- |
| `postgres`        | database      | Durable webhook dedupe, work items, pg-boss jobs                                               |
| `pr-agent-web`    | `ROLE=web`    | `POST /webhooks`, `GET /health`, `GET /ready` on port `7224`                                   |
| `pr-agent-worker` | `ROLE=worker` | Consumes ack, review, ask, description, triage, verification, CI-refresh, and retention queues |

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

Production credential hardening and extra deploy notes: [docs/operations.md](docs/operations.md).

## Create the GitHub App

1. Open [Register a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app).
2. Set **Webhook URL** to `https://<your-host>/webhooks` (Compose default port is `7224` if you terminate TLS in front of it).
3. Set **Webhook secret** to the same value as `WEBHOOK_SECRET` in `.env`.
4. Subscribe to these repository events (and only these for a normal install):
   - `pull_request`
   - `issue_comment`
   - `pull_request_review_comment`
   - `workflow_run` and `check_suite` (either completed event refreshes the CI row on an existing review summary when Actions finish later)
5. Do **not** require `pull_request_review` unless you have a reason. The bot does not need it for normal intake.
6. Repository permissions:

   | Permission      | Access       | Why                                               |
   | --------------- | ------------ | ------------------------------------------------- |
   | Issues          | Read & write | PR conversation comments and reactions            |
   | Pull requests   | Read & write | Reviews, inline threads, PR body for `/describe`  |
   | Contents        | Read & write | Read code; write only needed for `/triage` pushes |
   | Metadata        | Read         | Required by GitHub for apps                       |
   | Checks          | Read & write | Review check run + CI summary inputs              |
   | Actions         | Read         | Condensed job logs when CI fails                  |
   | Commit statuses | Read & write | Only if you set `FEATURE_COMMIT_STATUS=true`      |

7. Create the app, generate a **private key**, and copy the **App ID**.
8. Install the app on the orgs or repos you want reviewed.
9. Put `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` in `.env`, then recreate the containers so they pick up the change:

```bash
docker compose up -d --force-recreate pr-agent-web pr-agent-worker
```

## Point GitHub at your server

GitHub must reach `POST /webhooks` on the web service.

- **Production:** put TLS in front of `pr-agent-web` (Caddy, nginx, a load balancer, your PaaS). Forward to container port `7224`.
- **Laptop test:** use a tunnel such as [smee.io](https://smee.io) or Cloudflare Tunnel. Point the GitHub App webhook at the public URL, and forward that traffic to `http://127.0.0.1:7224/webhooks`.

Webhook handler path is always `/webhooks` (see [`src/effect/server.ts`](src/effect/server.ts)).

## Choose an LLM provider

LLM calls run on the **worker** only, through the Pi coding-agent runtime ([ADR 0031](docs/adr/0031-pi-native-agent-runtime.md)).

| What                    | Env vars                                            | Used for                                                               |
| ----------------------- | --------------------------------------------------- | ---------------------------------------------------------------------- |
| General primary         | `PI_PROVIDER`, `PI_MODEL`                           | Specialists, ask, describe, triage, verification, CI-summary authoring |
| Orchestrator (optional) | `PI_ORCHESTRATOR_PROVIDER`, `PI_ORCHESTRATOR_MODEL` | Review orchestrator session; empty means inherit general primary       |
| Fallback (optional)     | `PI_FALLBACK_PROVIDER`, `PI_FALLBACK_MODEL`         | Availability failures only; both must be set to enable                 |

Minimal OpenAI example:

```bash
PI_PROVIDER=openai
PI_MODEL=gpt-4o-mini
OPENAI_API_KEY=sk-...
```

- Startup checks `PI_PROVIDER` / `PI_MODEL` against the installed pi-ai list, or against a project `models.json` when that file is present.
- pr-agent loads `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `GOOGLE_GENERATIVE_AI_API_KEY` in [`src/config.ts`](src/config.ts). Other Pi providers use their usual env vars on the worker (for example `DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`). Full key table: [Pi providers](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md).
- Optional custom catalog: copy [`models.json.example`](models.json.example), place `models.json` at the repo root before `docker build` (copied to `/app/models.json` when present), mount it at runtime on **both** web and worker, or set `MODELS_JSON_PATH`. Details: [docs/operations.md](docs/operations.md).

Restart the worker after provider changes:

```bash
docker compose up -d --force-recreate pr-agent-worker
```

## Check that it works

```bash
curl -sS http://127.0.0.1:7224/health   # ok
curl -sS http://127.0.0.1:7224/ready    # ready (web: Postgres up)
```

Worker readiness (consumers registered + Postgres/pg-boss) is checked inside the Compose healthcheck on the worker container. From the host you only published the web port by default.

Then open a small PR on an installed repo, or comment `/help` on an existing PR.

| Expect                                      | Where                                      |
| ------------------------------------------- | ------------------------------------------ |
| Eyes reaction soon after intake             | PR or triggering comment                   |
| `## PR Agent Review` progress comment       | PR conversation (auto review or `/review`) |
| Inline findings on the Files tab            | When the bot can anchor them               |
| Final summary replaces the progress comment | Same conversation comment                  |

If webhooks return 200 but the PR stays quiet, the worker is down, misconfigured, or failing on the provider key. Check `docker compose logs -f pr-agent-worker` and the queue runbook: [docs/agent-work-ops.md](docs/agent-work-ops.md).

## What you get

Defaults match [`.env.example`](.env.example) and [docs/features.md](docs/features.md).

| Capability          | When it runs                                      | Command              |
| ------------------- | ------------------------------------------------- | -------------------- |
| Orchestrated review | PR `opened` when `FEATURE_REVIEW=auto`            | `/review` always     |
| PR description      | PR `opened` when `FEATURE_DESCRIBE=auto`          | `/describe`          |
| Verification        | PR `synchronize` when `FEATURE_VERIFICATION=auto` | (no slash)           |
| Ask                 | On demand when `FEATURE_ASK=manual`               | `/ask …` or `@bot …` |
| Triage autofix      | On demand when `FEATURE_TRIAGE=manual`            | `/triage`            |
| Cancel review       | On demand                                         | `/cancel`            |
| Restart review      | On demand (cancels the active run, latest commit) | `/review force`      |
| Help                | On demand                                         | `/help`              |

Review runs four specialists (correctness, security, quality, tests) under one orchestrator and posts one `## PR Agent Review` summary. P0-P2 findings fail the review check run; P3 does not. Docs-only trivial PRs can take a short auto path instead of a full orchestrated run ([ADR 0014](docs/adr/0014-lightweight-review-completion.md)).

Slash commands are case-sensitive. The command must be the first non-empty line of a **new** (`created`) comment. Who may run them is controlled by `SLASH_ALLOWED_ASSOCIATIONS` (default `OWNER,MEMBER,COLLABORATOR`).

Optional labels, commit status, and title rewrite are separate `FEATURE_*` flags. Set `FEATURE_DESCRIBE=off`, `FEATURE_ASK=off`, and similar when you want those features to stop calling the model.

## See it in action

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
  AckQ --> Worker["ROLE=worker executors"]
  CiRefQ --> Worker
  RevQ --> Worker
  AskQ --> Worker
  DescQ --> Worker
  TriageQ --> Worker
  VerifQ --> Worker
  RetQ --> Worker
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
4. **Worker** ([`AgentWorkerLive`](src/agentWork/worker.ts)) owns queue consumers, pg-boss supervision, and the daily retention sweep. One active run per PR per work type is enforced by the `pr_actor_leases` table ([ADR 0038](docs/adr/0038-pr-actor-lease.md)), not by queue policy, so a crashed worker's run is taken over once its lease lapses. Ask quota reservations release from terminal work-item transitions ([ADR 0039](docs/adr/0039-ask-admission-quotas.md)).
5. **Feature executors** ([`src/agentWork/executors/`](src/agentWork/executors/)) create a GitHub installation token, open a local PR workspace (or a writable checkout for triage), run the agent, and publish through the epoch- and cancellation-fenced `PrSurface` mutation boundary for leased work; ask remains unleased.
6. **Reviews** ([`runOrchestratedPrReview`](src/review/orchestrator/orchestratorRun.ts)) inspect the PR, write a specialist brief, run four specialists in parallel, publish inline thread batches, then write the final summary.

Queue inspection and recovery: [docs/agent-work-ops.md](docs/agent-work-ops.md). Design background: [ADR 0009](docs/adr/0009-durable-agent-work.md), [ADR 0008](docs/adr/0008-ask-command.md).

## Local development

Use this when you are changing the code. For production hosting, prefer Compose above.

`DATABASE_URL` is required for both roles ([`src/config.ts`](src/config.ts)).

```bash
docker compose up -d postgres
cp .env.example .env
# fill GitHub + provider fields

npm install -g --ignore-scripts=false @nubjs/nub
nub install

# terminal 1: webhook intake only
ROLE=web nub src/index.ts

# terminal 2: all queue consumers
ROLE=worker nub src/index.ts
```

`nub src/index.ts` loads `.env` automatically. Auto-restart: `nub watch src/index.ts`. Tunnel webhooks to `/webhooks` on your `PORT`.

If you previously installed with pnpm or npm at the repo root, delete `node_modules` before the first `nub install` so the virtual store is not mixed (`.pnpm/` vs Nub’s store).

```bash
# unit tests (no database)
nub run test

# integration tests
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

**Ask safety.** `/ask` applies outbound redaction before posting. Questions aimed at bot internals can get a short refusal without an LLM call ([ADR 0010](docs/adr/0010-ask-red-team-hardening.md)).

More security detail: [docs/operations.md](docs/operations.md#security).
