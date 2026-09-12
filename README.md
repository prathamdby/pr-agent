<div align="center">

<img src="assets/pr-agent-wordmark.png" alt="PR Agent" width="100%">

# PR Agent

Review pull requests on machines you own.

<p>
  <a href="https://deepwiki.com/prathamdby/pr-agent"><img src="https://img.shields.io/badge/DeepWiki-Ask-7B2CBF?style=for-the-badge" alt="Ask DeepWiki"></a>
  <a href="https://context7.com/prathamdby/pr-agent"><img src="https://img.shields.io/badge/Context7-Ask-4B0082?style=for-the-badge" alt="Ask Context7"></a>
  <a href="https://opencode.ai/go?ref=AHE1W13AS7"><img src="https://img.shields.io/badge/OpenCode-Go-2563EB?style=for-the-badge" alt="OpenCode Go"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-16A34A?style=for-the-badge" alt="License: MIT"></a>
  <a href="#documentation"><img src="https://img.shields.io/badge/Documentation-README-EAB308?style=for-the-badge" alt="Documentation"></a>
  <a href="#installation"><img src="https://img.shields.io/badge/Node-22+-EA580C?style=for-the-badge" alt="Node 22+"></a>
</p>

</div>

A pull request is opened on your project. PR Agent reads the change and comments next to the lines it flags.

You can have it write the description, answer a question in the thread, try a fix, or look again after you push.

CodeRabbit and the other hosted reviewers charge per person and keep your keys. This is free to install. You pay the computer and the AI bill, not a seat per teammate. You pick who reads the code.

## Contents

- [Features](#features)
- [Installation](#installation)
- [Verification](#verification)
- [Recommended hosts](#recommended-hosts)
- [Pratham's way of hosting](#prathams-way-of-hosting)
- [Examples](#examples)
- [Local development](#local-development)
- [Data privacy](#data-privacy)
- [Documentation](#documentation)

## Features

| Feature             | When it runs                                      | Command                         |
| ------------------- | ------------------------------------------------- | ------------------------------- |
| Orchestrated review | PR `opened` when `FEATURE_REVIEW=auto`            | `/review` always                |
| PR description      | PR `opened` when `FEATURE_DESCRIBE=auto`          | `/describe`                     |
| Verification        | PR `synchronize` when `FEATURE_VERIFICATION=auto` | `/verify`                       |
| Ask                 | On demand when `FEATURE_ASK=manual`               | `/ask …` or mention the App bot |
| Triage autofix      | On demand when `FEATURE_TRIAGE=manual`            | `/triage`                       |
| Cancel review       | On demand                                         | `/cancel`                       |
| Restart review      | On demand (cancels the active run, latest commit) | `/review force`                 |
| Help                | On demand                                         | `/help`                         |

Defaults match [`.env.example`](.env.example) and [docs/features.md](docs/features.md). `FEATURE_REVIEW` accepts only `manual` or `auto`. `off` crashes startup.

<details>
<summary>Review rules and slash matching</summary>

Review runs four specialists (correctness, security, quality, tests) under one orchestrator and posts one `## PR Agent Review` summary. A finding is published only when it meets the causal-publication contract. The orchestrator re-applies that contract during judgment. P0-P2 findings fail the review check run. P3 does not. Docs-only trivial PRs can take a short auto path instead of a full orchestrated run ([ADR 0010](docs/adr/0010-lightweight-review-completion.md)).

Slash commands are case-sensitive. The command must be the first non-empty line of a **new** (`created`) comment. Who may run them is controlled by `SLASH_ALLOWED_ASSOCIATIONS` (default `OWNER,MEMBER,COLLABORATOR`). Mention matching uses the App bot login, not the word `@bot`. `/ask` and `/help` do not need a mention.

Optional labels, commit status, and title rewrite are separate `FEATURE_*` flags. Set `FEATURE_DESCRIBE=off`, `FEATURE_ASK=off`, and similar when you want those features to stop calling the model.

</details>

## Installation

You need Docker Engine with Compose v2, a GitHub account that can create a GitHub App, one AI provider key, and a host GitHub can reach over HTTPS. A laptop can use a tunnel client instead of public TLS.

Create the GitHub App and paste a real private key before you start Compose. The example key in `.env.example` is not a real key. Both app containers exit if you start them without a generated App key.

### 1. Register the GitHub App

1. Open [Register a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app).
2. Set **Homepage URL** to this repository (`https://github.com/prathamdby/pr-agent`) or your public site. The form requires it. The App does not use it at runtime.
3. Leave **Identifying and authorizing users** off. Do not set a callback URL. This App does not use user login.
4. Set **Webhook URL** to `https://<your-host>/webhooks` once you have HTTPS, or a tunnel URL that forwards to `/webhooks`. You can save the App first and add the URL after the host is up.
5. Set **Webhook secret** now. Copy the same value into `WEBHOOK_SECRET` later.
6. Subscribe to `pull_request`, `issue_comment`, `pull_request_review_comment`, `workflow_run`, and `check_suite`. Do not require `pull_request_review` unless you have a reason.
7. Set repository permissions (table below). Create the app, generate a **private key**, and copy the **App ID**.
8. Install the app on the orgs or repos you want reviewed. Creating the App is not enough. If you pick **Only select repositories**, include the test repo.

| Permission      | Access       | Why                                               |
| --------------- | ------------ | ------------------------------------------------- |
| Issues          | Read & write | PR conversation comments and reactions            |
| Pull requests   | Read & write | Reviews, inline threads, PR body for `/describe`  |
| Contents        | Read & write | Read code; write only needed for `/triage` pushes |
| Metadata        | Read         | Required by GitHub for apps                       |
| Checks          | Read & write | Review check run + CI summary inputs              |
| Actions         | Read         | Condensed job logs when CI fails                  |
| Commit statuses | Read & write | Only if you set `FEATURE_COMMIT_STATUS=true`      |

`workflow_run` or `check_suite` (completed) refreshes the CI row on an existing review summary when Actions finish later.

### 2. Create the environment file

```bash
git clone https://github.com/prathamdby/pr-agent.git
cd pr-agent
cp .env.example .env
```

```bash
GITHUB_APP_ID=...
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
WEBHOOK_SECRET=replace-with-a-strong-secret
PI_PROVIDER=openai
PI_MODEL=gpt-4o-mini
OPENAI_API_KEY=sk-...
```

Paste the GitHub App private key as one line with `\n` for newlines, or as base64-encoded PEM. A literal multi-line PEM block is the form most likely to break Compose `env_file`. A placeholder or truncated PEM stops both app containers. Set the provider key before you expect a review to post. An empty `OPENAI_API_KEY` still boots.

<details>
<summary>Environment notes</summary>

- `WEBHOOK_SECRET` must match the secret you set on the GitHub App.
- Compose overrides `ROLE` and `DATABASE_URL` for each service. Web and worker use hostname `postgres` on the compose network. The `DATABASE_URL` in `.env.example` (`localhost:5432`) is for host processes only, and only after you publish Postgres. See [Local development](#local-development).
- Default HTTP port is `7224` (Compose and `.env.example`). Bare `nub src/index.ts` without `PORT` falls back to `3000`.
- `.env.example` sets `LOG_PRETTY=true` for a laptop. On a public host, set `LOG_PRETTY=false` or drop the line so production defaults apply. Change the default Postgres password if the host is reachable.
- Full env catalog: [docs/configuration.md](docs/configuration.md). Feature switches: [docs/features.md](docs/features.md).

</details>

### 3. Start the stack

```bash
docker compose build
docker compose up -d
```

| Service           | Role          | What it does                                                                                                     |
| ----------------- | ------------- | ---------------------------------------------------------------------------------------------------------------- |
| `postgres`        | database      | Durable webhook dedupe, work items, pg-boss jobs. Not published to the host.                                     |
| `pr-agent-web`    | `ROLE=web`    | `POST /webhooks`, `GET /health`, `GET /ready` on port `7224`                                                     |
| `pr-agent-worker` | `ROLE=worker` | Consumes ack, review, ask, description, triage, verification, CI-refresh, code-index-build, and retention queues |

Migrations run when each process opens its Postgres pool.

<details>
<summary>Compose overrides and the production overlay</summary>

```bash
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

</details>

### 4. Reach the webhook

GitHub must reach `POST /webhooks` on the web service over HTTPS. Localhost is the documented exception. Compose publishes HTTP `7224` only. There is no Caddy, nginx, or certificate in this repo. TLS is operator-owned.

**Production.** Put TLS in front of `pr-agent-web` (Caddy, nginx, a load balancer, your PaaS). Forward to container port `7224`. A Caddy example lives in [docs/operations.md](docs/operations.md#tls-in-front-of-compose).

**Laptop.** Start a tunnel client that forwards to `http://127.0.0.1:7224/webhooks`. A smee channel or Cloudflare hostname with no local client drops every delivery. GitHub can show 200 from the relay while this process sees nothing.

```bash
# smee.io: create a channel, then
npx smee-client -u https://smee.io/<channel> --target http://127.0.0.1:7224/webhooks

# or Cloudflare Tunnel, then set the App webhook to https://<trycloudflare-host>/webhooks
cloudflared tunnel --url http://127.0.0.1:7224
```

### 5. Set the model provider

LLM calls run on the **worker** only ([ADR 0023](docs/adr/0023-pi-native-agent-runtime.md)).

| What                    | Env vars                                            | Used for                                                               |
| ----------------------- | --------------------------------------------------- | ---------------------------------------------------------------------- |
| General primary         | `PI_PROVIDER`, `PI_MODEL`                           | Specialists, ask, describe, triage, verification, CI-summary authoring |
| Orchestrator (optional) | `PI_ORCHESTRATOR_PROVIDER`, `PI_ORCHESTRATOR_MODEL` | Review orchestrator session; empty means inherit general primary       |
| Fallback (optional)     | `PI_FALLBACK_PROVIDER`, `PI_FALLBACK_MODEL`         | Second attempt onward via retry escalation; both must be set to enable |

```bash
PI_PROVIDER=openai
PI_MODEL=gpt-4o-mini
OPENAI_API_KEY=sk-...
```

```bash
docker compose up -d --force-recreate pr-agent-worker
```

<details>
<summary>Provider catalog and models.json</summary>

- Without a catalog, worker boot only checks that `PI_PROVIDER` is a builtin. An unknown `PI_MODEL` falls through to that provider's first model API type. The first session then throws `provider.model_not_found`. Web never validates the model id. A present `models.json` does fail worker boot on a missing selection.
- pr-agent loads `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `GOOGLE_GENERATIVE_AI_API_KEY` in [`src/config.ts`](src/config.ts). If the Google alias is empty, pi-ai also reads `GEMINI_API_KEY` from the process environment. Other Pi providers use their usual env vars on the worker (for example `DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`). Provider catalog: [pi-ai](https://github.com/earendil-works/pi/tree/main/packages/ai).
- Optional custom catalog: copy [`models.json.example`](models.json.example), place `models.json` at the repo root before `docker build` (copied to `/app/models.json` when present), add a runtime mount on **both** web and worker (the committed compose file does not), or set `MODELS_JSON_PATH`. Details: [docs/operations.md](docs/operations.md).

</details>

## Verification

```bash
curl -sS http://127.0.0.1:7224/health   # ok
curl -sS http://127.0.0.1:7224/ready    # ready (web: Postgres up)
```

Then open a small PR on an **installed** repo. Comment `/help` as an owner, member, or collaborator (`SLASH_ALLOWED_ASSOCIATIONS`, default `OWNER,MEMBER,COLLABORATOR`).

| Expect                                      | Where                                      |
| ------------------------------------------- | ------------------------------------------ |
| Eyes reaction soon after intake             | PR or triggering comment                   |
| `## PR Agent Review` progress comment       | PR conversation (auto review or `/review`) |
| Inline findings on the Files tab            | When the bot can anchor them               |
| Final summary replaces the progress comment | Same conversation comment                  |

Default `FEATURE_VERIFICATION=auto` spends tokens on every push. Switch it to `manual` or `off` if that bill is too high.

<details>
<summary>What the probes do not prove</summary>

Those probes do not prove GitHub can reach `/webhooks`, that the worker has a provider key, or that App permissions match what publish code calls. An empty `OPENAI_API_KEY` still boots.

Worker readiness (consumers registered + Postgres/pg-boss) is checked inside the Compose healthcheck on the worker container (`GET /ready`). The image `HEALTHCHECK` hits `/health`, which is process liveness only. Compose overrides the worker check. From the host you only published the web port by default.

A contributor or outside commenter gets webhook `200` and no reply. That looks like a dead worker.

If webhooks return 200 but the PR stays quiet, check the worker logs, the provider key, App install (not just App create), slash allowlist, and the queue runbook: [docs/agent-work-ops.md](docs/agent-work-ops.md). `docker compose logs -f pr-agent-worker`.

</details>

## Recommended hosts

This repo still ships one stack: Compose `postgres`, `pr-agent-web`, and `pr-agent-worker`. A panel or reverse proxy only terminates TLS and forwards to web. Do not add a second compose file, publish Postgres, or expose the worker.

Start the VPS at about 2 vCPU and 4 GB RAM. Web, worker, Postgres, and a panel will not fit well on 1 GB.

| VPS                                            | Why pick it                                                                                         |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [Hetzner Cloud](https://www.hetzner.com/cloud) | Usually the cheapest 4 GB plan. NVMe, 20 TB traffic, sites in EU and the US.                        |
| [Hostinger VPS](https://www.hostinger.com/vps) | Simple checkout. Their Docker Manager can start a Compose file if you do not want a separate panel. |
| [DigitalOcean](https://www.digitalocean.com)   | Clear docs and a large marketplace. More regions. You pay more per GB of RAM.                       |
| [Vultr](https://www.vultr.com)                 | Many cities. High-frequency plans if you care about single-core speed.                              |
| [Linode (Akamai)](https://www.linode.com)      | Human support and a wide region list. Pricing is closer to DigitalOcean.                            |
| [OVHcloud](https://www.ovhcloud.com)           | EU sites, unmetered bandwidth on many plans, included DDoS mitigation.                              |

Hetzner is the default pick for this App. Hostinger is the default pick if you want a control panel from the VPS vendor. DigitalOcean, Vultr, and Linode are fine when you already have an account or need a city Hetzner does not offer.

| Panel                            | What it gives you                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| [Dokploy](https://dokploy.com)   | Native Compose deploy. Built-in Traefik. Let's Encrypt. A domain you paste into the GitHub App.                                            |
| [Coolify](https://coolify.io)    | Same idea. Traefik by default. Caddy is an option. Set the domain on the web service.                                                      |
| Caddy, nginx, or a load balancer | Fine if you already run one. Point it at container port `7224`. Example: [docs/operations.md](docs/operations.md#tls-in-front-of-compose). |

[CapRover](https://caprover.com) can sit in front of HTTP, but its Compose import is a subset. Prefer Dokploy, Coolify, or a proxy you already know.

On the panel, route only `pr-agent-web`. The public URL is `https://<your-domain>/webhooks`. Leave Compose Postgres unpublished. Keep `DATABASE_URL` on hostname `postgres` inside the compose network. If the panel asks for an internal port, use `7224`.

## Pratham's way of hosting

[Pratham](https://github.com/prathamdby) runs this App on all of his repositories, with every feature left on.

He runs it on a VPS with [Dokploy](https://dokploy.com). Dokploy's Traefik publishes the web service on a domain and issues the certificate. That HTTPS URL is what he puts on the GitHub App (`https://<domain>/webhooks`). The worker stays private. Postgres stays on the compose network.

Primary provider is [OpenCode Go](https://opencode.ai/go?ref=AHE1W13AS7) ($10 AI subscription). Model is Meta Muse Spark 1.3 Contributor.

That is his operator setup. The install path above still uses this repo's Compose file and the Pi provider env vars (`PI_PROVIDER`, `PI_MODEL`, and the matching API key). This repo does not add a Dokploy file or a second runtime.

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

## Local development

Use this when you are changing the code. For production hosting, use [Installation](#installation).

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

PORT=3000 ROLE=web nub src/index.ts
PORT=3001 ROLE=worker nub src/index.ts
```

`DATABASE_URL` is required for both roles. Nub loads `PORT` from `.env` (`7224`), so each role needs its own port.

<details>
<summary>Tests, Nub pin, and the landing site</summary>

`nub src/index.ts` loads `.env` automatically. Auto-restart: `nub watch src/index.ts`. Tunnel webhooks to `/webhooks` on the web `PORT`. Pin Nub to `0.7.2` (`package.json` `packageManager`, `Dockerfile`, `site/vercel.json`). Compose deploy does not need a host Nub install.

`docker compose up -d postgres` alone does not open host port `5432`. Full `docker compose up` works because web and worker get `DATABASE_URL` rewritten to `@postgres:5432`.

If you previously installed with pnpm or npm at the repo root, delete `node_modules` before the first `nub install` so the virtual store is not mixed (`.pnpm/` vs Nub’s store).

```bash
nub run test
DATABASE_URL=postgres://pr_agent:pr_agent@localhost:5432/pr_agent nub run test:integration
nub run check:code
```

Vitest does not load `.env` for you. Export `DATABASE_URL` in the shell for integration runs. Inventory-only suite that may skip DB cases: `nub run test:integration:inventory`.

More scripts and edge cases: [docs/operations.md](docs/operations.md#development), [docs/cursor-cloud.md](docs/cursor-cloud.md).

The marketing site under `site/` is a separate workspace package (`pr-agent-landing`). It is not required to run the bot. Agents should read `/llms.txt` or `/agents.md`, query `GET /llms?query=` / `GET /llms/json?query=`, and can fetch the page as markdown from `/index.md` or by sending `Accept: text/markdown` to `/`. Every endpoint is described in `/openapi.json`.

</details>

## Data privacy

| Topic         | Rule                                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Self-hosted   | Postgres, pg-boss, webhook bodies, and work-item state stay on your infrastructure. You own the GitHub App credentials.                                                               |
| LLM providers | Review text leaves your network only when the worker calls `PI_PROVIDER` / `PI_MODEL`. Read that provider's data policy.                                                              |
| Ask safety    | `/ask` applies outbound redaction before posting. Questions aimed at bot internals can get a short refusal without an LLM call ([ADR 0007](docs/adr/0007-ask-red-team-hardening.md)). |

<details>
<summary>Context7 and logging</summary>

**Context7 (optional).** Library lookup uses the fixed `https://context7.com/api` endpoint. Requests accept only short library identifiers and documentation questions; source, prompts, comments, credentials, URLs, and tool output are rejected before transmission. `CONTEXT7_API_KEY`, when set, is sent only as an `Authorization` header; empty keys use anonymous fallback.

**Logging.** Structured logs use [evlog](https://www.evlog.dev) on your hosts. `LOG_REDACT` defaults to true and strips secret-shaped substrings. AppError messages, contexts, raw values, causes, arrays, objects, and circular references are recursively sanitized at log and analytics boundaries; safe codes and identifiers remain available. See [the telemetry redaction policy](docs/operations.md#security).

</details>

## Documentation

| Document                                             | What it covers                                |
| ---------------------------------------------------- | --------------------------------------------- |
| [DeepWiki](https://deepwiki.com/prathamdby/pr-agent) | Ask questions against this repository         |
| [Context7](https://context7.com/prathamdby/pr-agent) | Ask questions against this repository         |
| [Features](docs/features.md)                         | `FEATURE_*` modes and slash commands          |
| [Configuration](docs/configuration.md)               | Env vars, defaults, and code constants        |
| [Operations](docs/operations.md)                     | TLS, host panels, scripts, production overlay |
| [Queue runbook](docs/agent-work-ops.md)              | Inspect and recover durable work              |
| [Development](docs/development.md)                   | Module layout and import rules                |
| [Cursor Cloud](docs/cursor-cloud.md)                 | Cloud VM services                             |
| [Domain terms](CONTEXT.md)                           | Product vocabulary                            |
| [ADRs](docs/adr/)                                    | Architecture decisions                        |
