<div align="center">

# PR Agent

**Self-hosted GitHub App for AI pull request reviews**

`pr-agent` · Node 22+ · Postgres · pg-boss

</div>

> **Async by design.** Webhooks return **`200`** after durable intake (Postgres + pg-boss enqueue). Reactions, progress comments, reviews, descriptions, ask answers, and auto-fix replies publish on **`ROLE=worker`** and may appear seconds later.

PR Agent is a GitHub App that enqueues durable **agent work items** (reviews, descriptions, asks, fixes) from webhooks and slash commands, then runs LLM agent loops on workers using local PR workspaces and GitHub APIs for publish.

Domain terms: [CONTEXT.md](CONTEXT.md). Configuration: [docs/configuration.md](docs/configuration.md). Behaviour and deployment: [docs/operations.md](docs/operations.md). Queue runbook: [docs/agent-work-ops.md](docs/agent-work-ops.md).

**[Get started](#getting-started)**

---

## Table of Contents

- [Getting Started](#getting-started)
- [Configure the agent provider](#configure-the-agent-provider)
- [Why Use PR Agent?](#why-use-pr-agent)
- [Features](#features)
- [See It in Action](#see-it-in-action)
- [How It Works](#how-it-works)
- [Data Privacy](#data-privacy)

## Getting Started

### 1. GitHub App

1. Create a [GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app).
2. Set **Webhook URL** to `https://<host>/webhooks` and **Webhook secret** to match `WEBHOOK_SECRET`.
3. Subscribe to events: **`pull_request`**, **`issue_comment`**, **`pull_request_review_comment`** (do not require `pull_request_review`).
4. Repository permissions (typical): **Issues** and **Pull requests** read/write, **Contents** read/write, **Metadata** read.
5. Install the app on target orgs or repos. Set `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` in `.env` (see [`.env.example`](.env.example)).

### 2. Docker Compose (recommended)

Full stack: Postgres, web intake, and worker consumers.

```bash
cp .env.example .env
# Set GITHUB_*, WEBHOOK_SECRET, and agent provider keys (see Configure the agent provider)
docker compose build
docker compose up
```

- Webhook URL (default ports): `http://<host>:7224/webhooks`
- **`GET /health`**: liveness (`ok`)
- **`GET /ready`**: readiness (Postgres reachable)
- Both **`pr-agent-web`** (`ROLE=web`) and **`pr-agent-worker`** (`ROLE=worker`) are required for reviews, descriptions, asks, and fixes.

More deployment detail: [docs/operations.md](docs/operations.md).

### 3. Local development (optional)

`DATABASE_URL` is required for both roles ([`src/config.ts`](src/config.ts)).

```bash
docker compose up postgres
cp .env.example .env
corepack enable
pnpm install

# terminal 1: enqueue only
ROLE=web DATABASE_URL=postgres://pr_agent:pr_agent@localhost:5432/pr_agent pnpm dev

# terminal 2: reviews, descriptions, asks, fixes
ROLE=worker DATABASE_URL=postgres://pr_agent:pr_agent@localhost:5432/pr_agent pnpm dev
```

`pnpm dev` alone does not load `.env`. Prefer `node --env-file=.env --import tsx src/index.ts` when you need env file values. Tunnel webhooks (e.g. [smee.io](https://smee.io)) to `/webhooks`.

Minimal env:

```bash
DATABASE_URL=...
GITHUB_APP_ID=...
GITHUB_APP_PRIVATE_KEY=...
WEBHOOK_SECRET=...
# Agent provider: see Configure the agent provider
```

Developer scripts: see [docs/operations.md](docs/operations.md#development).

## Configure the agent provider

LLM runs happen on **`ROLE=worker`** only. Pick a **runner** with `AGENT_PROVIDER`, then set model and credentials.

| Runner       | `AGENT_PROVIDER` | Model env                    | Credentials                           |
| ------------ | ---------------- | ---------------------------- | ------------------------------------- |
| Pi (default) | `pi`             | `PI_PROVIDER`, `PI_MODEL`    | Provider API key env vars (see below) |
| Cursor SDK   | `cursor`         | `PI_MODEL` (Cursor model id) | `CURSOR_API_KEY` (required)           |

Full tunables: [docs/configuration.md](docs/configuration.md). Cursor integration: [ADR 0013](docs/adr/0013-cursor-sdk-provider.md).

### Pi runner (default)

Uses [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi/tree/main/packages/ai) and the Pi coding-agent session loop.

```bash
AGENT_PROVIDER=pi
PI_PROVIDER=openai
PI_MODEL=gpt-4o-mini
OPENAI_API_KEY=sk-...
```

- **`PI_PROVIDER`**: pi-ai provider slug (for example `openai`, `anthropic`, `google`, `deepseek`, `openrouter`, `amazon-bedrock`, `groq`). Startup validates against the installed pi-ai provider list.
- **`PI_MODEL`**: model id for that provider (for example `gpt-4o`, `claude-sonnet-4-5`).
- **API keys**: set the env var for your provider. pr-agent loads **`OPENAI_API_KEY`**, **`ANTHROPIC_API_KEY`**, and **`GOOGLE_GENERATIVE_AI_API_KEY`** into the worker at startup. Other Pi providers use their standard env vars in the worker process (for example `DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`). See the [Pi providers reference](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md) for the full key table, cloud setup (Azure, Bedrock, Vertex), and custom endpoints.

Do **not** set `PI_PROVIDER=cursor`. Use `AGENT_PROVIDER=cursor` for Cursor models instead.

### Cursor runner

Uses the Cursor SDK local agent with an HTTP MCP bridge to pr-agent's GitHub, Context7, and `submitReview` tools. Register at worker boot only.

```bash
AGENT_PROVIDER=cursor
CURSOR_API_KEY=...
PI_MODEL=composer-2.5
```

- **`CURSOR_API_KEY`**: required when `AGENT_PROVIDER=cursor`.
- **`PI_MODEL`**: Cursor model id from `Cursor.models.list()`. The worker fetches the live catalog at boot and validates your choice. Common ids (first ten from a typical list): `composer-2.5`, `composer-2`, `gpt-5.5`, `gpt-5.4-high`, `claude-opus-4-7`, `claude-opus-4-8`, `claude-4.6-sonnet-high-thinking`, `gpt-5.3-codex-high`, `gemini-3.1-pro`, `auto`. Append `-fast` for the fast tier when the SDK exposes a `fast` parameter (for example `composer-2.5-fast`, `gpt-5.5-fast`). Plain ids use the standard tier.
- **`PI_PROVIDER`** is ignored for Cursor runs.

Restart **`pr-agent-worker`** (or the `ROLE=worker` process) after changing provider env vars.

## Why Use PR Agent?

### Fast, durable intake

Webhook handlers validate, dedupe, and enqueue work in Postgres before responding. Workers scale independently; a review backlog does not block webhook acceptance.

### Handles large pull requests

File listing and patch caps (`MAX_PR_FILES_LISTED`, `MAX_PR_FILES_PATCH_BYTES`) plus Octokit throttling keep runs bounded. Truncation metadata is explicit when the change set is clipped.

### Customizable via configuration

Tunables live in env vars and [docs/configuration.md](docs/configuration.md). Prompt prose stays in code; limits and shared strings live in `src/settings/`.

### Self-hosted control

Run on your infrastructure with your GitHub App credentials and chosen LLM provider (Pi/OpenAI, Cursor SDK, and others via `@earendil-works/pi-ai`).

### Specialized review lenses

General bug-and-correctness reviews run on PR open and sync. **`/review-security`** and **`/review-quality`** add separate **review summary comments** on demand, each with its own **review lens** and progress comment.

## Features

| Capability              | Auto on PR             | Slash command      | Notes                                                                                     |
| ----------------------- | ---------------------- | ------------------ | ----------------------------------------------------------------------------------------- |
| General review          | opened / sync / reopen | `/review`          | `## PR Agent Review`; inline P0 to P2 on Files tab when present                           |
| PR description          | same                   | `/describe`        | Merges under `## PR Agent Description`                                                    |
| Security lens           | No                     | `/review-security` | `## PR Agent Security Review`                                                             |
| Quality lens            | No                     | `/review-quality`  | `## PR Agent Quality Review`                                                              |
| Ask                     | No                     | `/ask <question>`  | PR conversation or inline diff **code anchor**                                            |
| Auto-fix                | No                     | `/fix`, `/fix-all` | Worker commits fixes for persisted P0 to P2 PR Agent findings                             |
| Help                    | No                     | `/help`            | Worker-published guidance                                                                 |
| Lightweight auto-review | docs-only trivial PRs  | No                 | Skips full **review run**; see [ADR 0014](docs/adr/0014-lightweight-review-completion.md) |

| Deployment                                | Supported |
| ----------------------------------------- | --------- |
| Docker Compose (web + worker + Postgres)  | Yes       |
| Bare Node + Postgres                      | Yes       |
| Cursor provider (`AGENT_PROVIDER=cursor`) | Yes       |

Slash commands are **case-sensitive** and must start the first non-empty line of a new comment. Full behaviour: [docs/operations.md](docs/operations.md).

## See It in Action

<details>
  <summary><h3>/describe</h3></summary>
  <img src="docs/readme/assets/describe.example.png" alt="Example /describe output showing PR Agent Description block" width="800" />
</details>

<details>
  <summary><h3>/review</h3></summary>
  <img src="docs/readme/assets/review.example.png" alt="Example /review output showing PR Agent Review summary" width="800" />
</details>

<details>
  <summary><h3>/ask</h3></summary>
  <img src="docs/readme/assets/ask.example.png" alt="Example /ask answer on a pull request" width="800" />
</details>

<details>
  <summary><h3>/review-security</h3></summary>
  <img src="docs/readme/assets/review-security.example.png" alt="Example /review-security output showing PR Agent Security Review summary" width="800" />
</details>

<details>
  <summary><h3>/review-quality</h3></summary>
  <img src="docs/readme/assets/review-quality.example.png" alt="Example /review-quality output showing PR Agent Quality Review summary" width="800" />
</details>

## How It Works

```mermaid
flowchart LR
  GitHub[GitHub webhooks] --> Web["ROLE=web /webhooks"]
  Web --> Dedupe[Postgres webhook_events dedupe]
  Dedupe --> Items[agent_work_items]
  Items --> Boss[pg-boss enqueue]
  Boss --> AckQ[ack queue]
  Boss --> RevQ[review queue]
  Boss --> AskQ[ask queue]
  Boss --> DescQ[description queue]
  Boss --> FixQ[fix queue]
  AckQ --> Worker["ROLE=worker executors"]
  RevQ --> Worker
  AskQ --> Worker
  DescQ --> Worker
  FixQ --> Worker
  Worker --> LLM[LLM plus tools]
  LLM --> Publish[GitHub PR-surface publish]
```

1. **Web** ([`processWebhookRequestEffect`](src/effect/programs/processWebhookRequestEffect.ts)): verify signature, parse payload, durable dedupe, schedule **agent work items**.
2. **Scheduler** ([`AgentWorkScheduler`](src/agentWork/scheduler.ts)): write Postgres rows and enqueue pg-boss jobs (ack, review, ask, description, fix).
3. **Ack worker**: acknowledgement reaction and **review progress comment** stub before long runs.
4. **Review / ask / description / fix workers** ([`executors/`](src/agentWork/executors/)): installation token, local PR workspace, agent harness, **PR-surface I/O**. Auto-fix runs use a split workspace: provider-visible scratch space plus a server-owned writable checkout.
5. **Reviews** ([`runFullPrReview`](src/review/reviewRun.ts)): investigation tools, then one structured **`submitReview`** publish path.
6. **Auto-fix** ([`executeFixJob`](src/agentWork/executors/fixExecutor.ts)): resolve persisted findings, check issuer permission, let the agent edit only through server tools, commit with the GitHub App bot identity, then direct-push or open a replacement PR.

Queue inspection and recovery: [docs/agent-work-ops.md](docs/agent-work-ops.md). Architecture ADR: [docs/adr/0009-durable-agent-work.md](docs/adr/0009-durable-agent-work.md).

## Data Privacy

### Self-hosted

Postgres, pg-boss, and GitHub App credentials run on your infrastructure. Webhook bodies and workflow state stay in your database.

### LLM providers

Review, description, ask, and auto-fix context is sent to your configured model provider during worker runs only (Pi/OpenAI, Cursor, or others per `PI_PROVIDER` / `AGENT_PROVIDER`). See your provider's data policy (for example [OpenAI](https://openai.com/enterprise-privacy) or Cursor).

### Context7 (optional)

When enabled, library lookup tools may call `https://context7.com/api`. Set `CONTEXT7_API_KEY` for higher limits; queries leave your network to Context7 when those tools run.

### Logging

Structured logs use [evlog](https://www.evlog.dev) on your hosts. `LOG_REDACT` (default true) redacts secret-shaped substrings; tune via [docs/configuration.md](docs/configuration.md).

### Ask safety

`/ask` replies apply outbound redaction before posting. Probes for bot internals may receive an **Ask meta refusal** without an LLM call ([ADR 0010](docs/adr/0010-ask-red-team-hardening.md)).

More security detail: [docs/operations.md](docs/operations.md#security).
