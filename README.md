<div align="center">

<img src="assets/pr-agent-banner.webp" alt="PR Agent. Review pull requests on machines you own." width="100%">

<p>
  <a href="https://deepwiki.com/prathamdby/pr-agent"><img src="assets/badges/deepwiki.png" alt="Ask DeepWiki" height="48"></a>
  <a href="https://context7.com/prathamdby/pr-agent"><img src="assets/badges/context7.png" alt="Ask Context7" height="48"></a>
  <a href="https://opencode.ai/go?ref=AHE1W13AS7"><img src="assets/badges/opencode.png" alt="OpenCode Go" height="48"></a>
  <br>
  <a href="LICENSE"><img src="assets/badges/license.png" alt="MIT license" height="48"></a>
  <a href="#documentation"><img src="assets/badges/docs.png" alt="Documentation" height="48"></a>
  <a href="#installation"><img src="assets/badges/node.png" alt="Node 22+" height="48"></a>
</p>

</div>

A pull request is opened on your project. PR Agent reads the change and comments next to the lines it flags.

You can have it write the description, answer a question in the thread, try a fix, or look again after you push.

CodeRabbit and the other hosted reviewers charge per person and keep your keys. This is free to install. You pay the computer and the AI bill, not a seat per teammate. You pick who reads the code.

## Contents

- [Features](#features)
- [Installation](#installation)
- [Verification](#verification)
- [Examples](#examples)
- [Recommended hosts](#recommended-hosts)
- [Pratham's way of hosting](#prathams-way-of-hosting)
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

Defaults match [`.env.example`](.env.example) and [docs/features.md](docs/features.md). `FEATURE_REVIEW` accepts only `manual` or `auto`. `off` crashes startup. `FEATURE_ASK` and `FEATURE_TRIAGE` accept only `off` or `manual`. `auto` aborts startup.

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
6. Subscribe to `pull_request`, `issue_comment`, `pull_request_review_comment`, `workflow_run`, `check_suite`, `check_run`, and `status`. Do not require `pull_request_review` unless you have a reason.
7. Set repository permissions (table below). Create the app, generate a **private key**, and copy the **App ID**.
8. Install the app on the orgs or repos you want reviewed. Creating the App is not enough. If you pick **Only select repositories**, include the test repo.

| Permission      | Access       | Why                                                                             |
| --------------- | ------------ | ------------------------------------------------------------------------------- |
| Issues          | Read & write | PR conversation comments and reactions                                          |
| Pull requests   | Read & write | Reviews, inline threads, PR body for `/describe`                                |
| Contents        | Read & write | Read code; write only needed for `/triage` pushes                               |
| Metadata        | Read         | Required by GitHub for apps                                                     |
| Checks          | Read & write | Review check run + CI summary inputs                                            |
| Actions         | Read         | Condensed job logs when CI fails                                                |
| Commit statuses | Read         | Legacy `status` events and CI facts. Add write if `FEATURE_COMMIT_STATUS=true`. |

`workflow_run` or `check_suite` (completed) refreshes the CI row and action line on an existing review summary when Actions finish later. `check_run` (`created`, `completed`) and `status` are recorded for the head even when no PR is known yet. Opening, synchronizing, or reopening a pull request also enqueues a snapshot when that head has no seeded row. Ack and publish do the same after they write the comment. A missing or unseeded snapshot shows **Waiting for CI**. A complete snapshot with no external checks shows **No CI checks on this head**. Own-App `check_run` and `check_suite` deliveries are ignored.

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
- Compose overrides `ROLE` and `DATABASE_URL` for each service. Web and worker use hostname `postgres` on the compose network. The `DATABASE_URL` in `.env.example` (`localhost:5432`) is for host integration tests and optional host processes. [Local development](#local-development) publishes that port from `docker-compose.dev.yml`. Production Compose does not.
- Default HTTP port is `7224` (Compose and `.env.example`). Maintainer-local Compose also publishes worker `7225`. Bare `nub src/index.ts` without `PORT` falls back to `3000`.
- `.env.example` sets `LOG_PRETTY=true` for a laptop. On a public host, set `LOG_PRETTY=false` or drop the line so production defaults apply. Change the default Postgres password if the host is reachable.
- Full env catalog: [docs/configuration.md](docs/configuration.md). Feature switches: [docs/features.md](docs/features.md).

</details>

### 3. Start the stack

```bash
docker compose build
docker compose up -d
```

| Service           | Role          | What it does                                                                                                        |
| ----------------- | ------------- | ------------------------------------------------------------------------------------------------------------------- |
| `postgres`        | database      | Durable webhook dedupe, work items, pg-boss jobs. Not published to the host.                                        |
| `pr-agent-web`    | `ROLE=web`    | `POST /webhooks`, `GET /health`, `GET /ready` on port `7224`                                                        |
| `pr-agent-worker` | `ROLE=worker` | Consumes ack, review, ask, description, triage, verification, CI-projection, code-index-build, and retention queues |

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

GitHub must reach `POST /webhooks` on the web service over HTTPS. Localhost is the documented exception. Production Compose publishes HTTP `7224` only. Laptop Caddy and the Cloudflare quick tunnel are [docker-compose.dev.yml](docker-compose.dev.yml). Production TLS is still operator-owned.

**Production.** Put TLS in front of `pr-agent-web` (Caddy, nginx, a load balancer, your PaaS). Forward to container port `7224`. A Caddy example lives in [docs/operations.md](docs/operations.md#tls-in-front-of-compose).

**Laptop.** Use [Local development](#local-development). That Compose file starts a Cloudflare quick tunnel to the web process. Print the public webhook URL and paste it on the GitHub App. Do not point the App at Caddy. A hostname with no running `cloudflared` service drops every delivery. GitHub can show 200 from the relay while this process sees nothing.

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
- Custom provider fields, a minimal proxy example, and verification: [docs/configuration.md](docs/configuration.md#custom-model-providers).

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

## Examples

<table>
  <tr>
    <td width="36%" valign="middle">
      <h3>Review on the pull request</h3>
      <p>Flags problems on the change and comments next to the lines. The summary stays in the conversation.</p>
    </td>
    <td width="64%">
      <img src="site/public/screenshots/review.example.webp" alt="PR Agent review summary on a pull request" width="100%" />
    </td>
  </tr>
  <tr>
    <td width="36%" valign="middle">
      <h3>Description in the PR body</h3>
      <p>Turns a blank pull request body into a readable summary. Bullets and optional visual sketches land on the PR when the diff proves them.</p>
    </td>
    <td width="64%">
      <img src="site/public/screenshots/describe.example.webp" alt="PR Agent description block in a pull request body" width="100%" />
    </td>
  </tr>
  <tr>
    <td width="36%" valign="middle">
      <h3>Ask in the thread</h3>
      <p>Answers a question about the change in the same conversation. You stay on GitHub.</p>
    </td>
    <td width="64%">
      <img src="site/public/screenshots/ask.example.webp" alt="PR Agent answer on a pull request" width="100%" />
    </td>
  </tr>
  <tr>
    <td width="36%" valign="middle">
      <h3>Triage the findings</h3>
      <p>Revisits earlier findings, fixes what it can, and pushes the commit. Each finding gets a verdict. Dismissed ones come with policy suggestions for your repo.</p>
    </td>
    <td width="64%">
      <img src="site/public/screenshots/triage.example.webp" alt="PR Agent triage report with a verdict for each finding" width="100%" />
    </td>
  </tr>
</table>

## Recommended hosts

Production hosting still ships one stack: Compose `postgres`, `pr-agent-web`, and `pr-agent-worker`. A panel or reverse proxy only terminates TLS and forwards to web. Do not add another production or panel compose file, publish Postgres, or expose the worker. Maintainer-local work uses [docker-compose.dev.yml](docker-compose.dev.yml).

Start the VPS at about 2 vCPU and 4 GB RAM. Web, worker, Postgres, and a panel will not fit well on 1 GB.

| VPS                                            | Why pick it                                                                                         |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [Hetzner Cloud](https://www.hetzner.com/cloud) | Usually the cheapest 4 GB plan. NVMe, 20 TB traffic, sites in EU and the US.                        |
| [Hostinger VPS](https://www.hostinger.com/vps) | Simple checkout. Their Docker Manager can start a Compose file if you do not want a separate panel. |
| [DigitalOcean](https://www.digitalocean.com)   | Clear docs and a large marketplace. More regions. You pay more per GB of RAM.                       |

Hetzner is the default pick for this App. Hostinger is the default pick if you want a control panel from the VPS vendor. DigitalOcean is fine when you already have an account.

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

## Local development

Use this when you are changing the code. For production hosting, use [Installation](#installation).

```bash
docker compose -f docker-compose.dev.yml up -d --build
node dev/print-public-webhook-url.cjs
```

That one file starts Postgres, Caddy, web, worker, and a Cloudflare quick tunnel to the web process. [`dev/mock.env`](dev/mock.env) has fake App id and webhook secret. The boot script generates a throwaway PEM at process start. Those values are not a real App.

The print script writes the public webhook URL (`https://<id>.trycloudflare.com/webhooks`). Paste that on the GitHub App. The hostname changes when you recreate `cloudflared`. Update the App field after a restart.

| URL                               | Role                                          |
| --------------------------------- | --------------------------------------------- |
| printed trycloudflare `/webhooks` | GitHub App webhook (public HTTPS)             |
| printed trycloudflare `/health`   | Web liveness through the tunnel               |
| `https://web.localhost/health`    | Web liveness on the laptop                    |
| `https://web.localhost/ready`     | Web Postgres ping on the laptop               |
| `https://web.localhost/webhooks`  | Durable intake on the laptop (not for GitHub) |
| `https://worker.localhost/health` | Worker liveness                               |
| `https://worker.localhost/ready`  | Worker consumers plus Postgres                |

```bash
curl -k https://web.localhost/health
curl -k https://web.localhost/ready
curl -k https://worker.localhost/health
curl -k https://worker.localhost/ready
```

If `web.localhost` does not resolve, add `127.0.0.1 web.localhost worker.localhost` to `/etc/hosts`, or pass `--resolve web.localhost:443:127.0.0.1` to `curl`.

Caddy uses an internal certificate. GitHub will not trust it. The Compose `cloudflared` service is the public path. Do not add a host smee or `cloudflared` process unless that service cannot reach Cloudflare.

Published ports bind `127.0.0.1`. Binding `80` and `443` on all interfaces exposes the laptop on the LAN.

If you already run `docker compose up -d postgres` or a published `docker run` Postgres on `5432`, stop that container first so host port `5432` is free. This file uses its own `postgres-data-dev` volume. `compose down` keeps that volume.

For live App deliveries, put real GitHub fields in `.env` and start with `PR_AGENT_ENV_FILE=.env docker compose -f docker-compose.dev.yml up -d --build`.

Do not start [docker-compose.yml](docker-compose.yml) at the same time. That file is the self-host path. It has no Caddy, no tunnel, and does not publish Postgres.

<details>
<summary>Tests, Nub pin, and the landing site</summary>

`docker-compose.dev.yml` publishes Postgres at `localhost:5432`. Integration tests use that URL. Unit tests do not need the database, Caddy, or the tunnel.

```bash
nub run test
DATABASE_URL=postgres://pr_agent:pr_agent@localhost:5432/pr_agent nub run test:integration
nub run check:code
```

Vitest does not load `.env` for you. Export `DATABASE_URL` in the shell for integration runs. Inventory-only suite that may skip DB cases: `nub run test:integration:inventory`.

Host Nub is optional on this path. Pin it to `0.7.2` when you install it (`package.json` `packageManager`, `Dockerfile`, `site/vercel.json`). Use `nub watch src/index.ts` only if you want to edit TypeScript on the host instead of rebuilding the image. Give the two roles distinct `PORT` values. Do not copy `PORT=7224` onto both terminals.

If you previously installed with pnpm or npm at the repo root, delete `node_modules` before the first `nub install` so the virtual store is not mixed (`.pnpm/` vs Nub’s store).

More scripts and edge cases: [docs/operations.md](docs/operations.md#development), [docs/cursor-cloud.md](docs/cursor-cloud.md).

The marketing site under `site/` is a separate workspace package (`pr-agent-landing`). It is not required to run the bot. Agents should read `/llms.txt` or `/agents.md`, query `GET /llms?query=` / `GET /llms/json?query=`, and can fetch the page as markdown from `/index.md` or by sending `Accept: text/markdown` to `/`. Every endpoint is described in `/openapi.json`.

</details>

## Data privacy

| Topic         | Rule                                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Self-hosted   | Postgres, pg-boss, webhook bodies, and work-item state stay on your infrastructure. You own the GitHub App credentials.                                                               |
| LLM providers | Review text leaves your network only when the worker calls `PI_PROVIDER` / `PI_MODEL`. Read that provider's data policy.                                                              |
| Ask safety    | `/ask` applies outbound redaction before posting. Questions aimed at bot internals can get a short refusal without an LLM call ([ADR 0007](docs/adr/0007-ask-red-team-hardening.md)). |
| Retention     | Agent event rows older than 30 days are deleted with the other cleanup. Set `AGENT_EVENTS_RETENTION_SECONDS` to `0` to keep them.                                                     |

<details>
<summary>Context7</summary>

Library lookup uses the fixed `https://context7.com/api` endpoint. Requests accept only short library identifiers and documentation questions; source, prompts, comments, credentials, URLs, and tool output are rejected before transmission. `CONTEXT7_API_KEY`, when set, is sent only as an `Authorization` header; empty keys use anonymous fallback.

</details>

<details>
<summary>Logging</summary>

Structured logs use [evlog](https://www.evlog.dev) on your hosts. `LOG_REDACT` defaults to true and strips secret-shaped substrings. AppError messages, contexts, raw values, causes, arrays, objects, and circular references are recursively sanitized at log and analytics boundaries; safe codes and identifiers remain available. See [the telemetry redaction policy](docs/operations.md#security).

</details>

<details>
<summary>PostHog</summary>

PR Agent can send work and webhook events to [PostHog](https://posthog.com). Set `POSTHOG_PROJECT_TOKEN` in `.env`. Leave it empty and nothing is sent. Use `POSTHOG_HOST` only if your project is not on the default host. Prompts, diffs, and error text stay off that path. Env catalog: [docs/configuration.md](docs/configuration.md).

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
