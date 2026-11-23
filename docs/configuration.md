# Configuration catalog

Deployment wiring (infra) and operator tuning (ops) for **pr-agent**. The
user-facing settings are the nine `FEATURE_*` vars — see
[features.md](features.md); they are not repeated here. Shared code defaults live in
[`src/settings/`](../src/settings/); env vars are loaded in
[`src/settings/config.ts`](../src/settings/config.ts), which composes the slice readers under `src/settings/slices/`.

For behaviour, deployment, and developer scripts see [operations.md](operations.md). Agent index: [AGENTS.md](../AGENTS.md).

## How to change something

| Kind         | Where to edit                                                                                                                                                                                        |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **feature**  | `.env` → `FEATURE_*` keys; catalog and semantics in [features.md](features.md)                                                                                                                       |
| **env**      | `.env` / deployment env → keys below. Defaults live in `src/settings/defaults.ts`, plus ask-quota defaults there, and `LOG_PRETTY` in `src/settings/slices/service.ts` (`NODE_ENV !== "production"`) |
| **code**     | `src/settings/constants.ts`                                                                                                                                                                          |
| **external** | Provider env; loaded into config but never logged                                                                                                                                                    |

Import convention: `import { … } from "../settings/index.js"` for shared constants; `Config` from `config.ts` at runtime. Single-owner slash replies are private to `src/state/intake.ts`.

### When you change a knob

| Change                       | Update                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------- |
| New or changed feature       | `featureModes.ts`, `envKeys.ts`, `config.ts`, `.env.example`, `docs/features.md`  |
| New or renamed env var       | `envKeys.ts`, `defaults.ts`, `config.ts`, `.env.example`, `docs/configuration.md` |
| New or changed code constant | `constants.ts`, `docs/configuration.md`                                           |
| Default value only           | `defaults.ts`, `.env.example` (if documented there), `docs/configuration.md`      |

Do not add magic numbers or duplicate env defaults in feature modules. Shared settings come from `src/settings/`; named constants with one production owner stay private to that module.

CI enforces env alignment via `test/settingsInventory.test.ts` (including that every `FEATURE_*` key appears in `docs/features.md`). Loadable env names are `ENV` plus `EXTERNAL_ENV` in [`src/settings/envKeys.ts`](../src/settings/envKeys.ts), plus provider secrets Pi reads from `process.env` (`DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`, and others documented in [README.md](../README.md)). `docs/configuration.md` code-constant rows are maintained on the honor system. A backtick `SCREAMING_NAME` in a code-constant row is not an env var unless its Kind column says **env**.

---

## Infra (required wiring and provider selection)

| Name                       | Env var                          | Default                         | Notes                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------- | -------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP port                  | `PORT`                           | `3000` (7224 in Compose)        | Process default is `3000`. The image and every Compose file pin `7224`.                                                                                                                                                                                                                                                                                           |
| GitHub App ID              | `GITHUB_APP_ID`                  | —                               | required                                                                                                                                                                                                                                                                                                                                                          |
| App private key            | `GITHUB_APP_PRIVATE_KEY`         | —                               | required PEM                                                                                                                                                                                                                                                                                                                                                      |
| Webhook HMAC secret        | `WEBHOOK_SECRET`                 | —                               | required                                                                                                                                                                                                                                                                                                                                                          |
| SQLite directory           | `SQLITE_DIR`                     | `./data` (`/data` in the image) | Directory for `app_state.sqlite`, `pi_durable.sqlite`, the `pr-agent.lock.sqlite` single-writer lock, and `archive/` (reset `pi_durable.sqlite` copies). Created at boot. Exactly one process may use a directory; a second fails fast on the lock. Compose mounts a named volume here.                                                                           |
| app_state path override    | `SQLITE_DB_PATH`                 | empty                           | Optional path to a regular file directly inside `SQLITE_DIR`. Links and the lock or Pi database names are refused. Empty keeps `${SQLITE_DIR}/app_state.sqlite`.                                                                                                                                                                                                  |
| General LLM provider       | `PI_PROVIDER`                    | `openai`                        | Primary model provider for Specialist, Ask, Description, Triage, Verification, and CI-summary sessions (built-in slug or `models.json` key)                                                                                                                                                                                                                       |
| General LLM model          | `PI_MODEL`                       | `gpt-4o-mini`                   | Primary model id for general sessions                                                                                                                                                                                                                                                                                                                             |
| Orchestrator provider      | `PI_ORCHESTRATOR_PROVIDER`       | empty                           | Optional override for Review orchestrator sessions; empty inherits `PI_PROVIDER`                                                                                                                                                                                                                                                                                  |
| Orchestrator model         | `PI_ORCHESTRATOR_MODEL`          | empty                           | Optional override for Review orchestrator sessions; empty inherits `PI_MODEL`                                                                                                                                                                                                                                                                                     |
| Fallback provider          | `PI_FALLBACK_PROVIDER`           | empty                           | Optional shared fallback provider; must be set with `PI_FALLBACK_MODEL`. Retry escalation runs attempt 2 and later on the fallback model                                                                                                                                                                                                                          |
| Fallback model             | `PI_FALLBACK_MODEL`              | empty                           | Optional shared fallback model; empty disables fallback. When configured, retry escalation uses it from the second attempt onward                                                                                                                                                                                                                                 |
| Thinking ceiling           | `PI_THINKING_CEILING`            | `high`                          | Max thinking level for phase-aware thinking (`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`). Recon, specialist, judgment, ask, and triage turns ask for `medium`; other phases ask for `low`. On `anthropic-messages`, one review orchestrator session holds the highest level of its phases, because a mid-session effort change rewrites the prompt cache |
| Provider transport retries | `PI_PROVIDER_RETRY_MAX`          | `2`                             | Extra transport attempts per provider request on retryable 429/5xx/network failures; `0` disables provider transport retry, not Core turn retry after a retryable assistant error (`SESSION_TURN_RETRY_MAX`)                                                                                                                                                      |
| Provider retry delay cap   | `PI_PROVIDER_MAX_RETRY_DELAY_MS` | `60000`                         | Bounds a provider-requested retry delay (e.g. `Retry-After`); must be strictly less than `PROVIDER_PROMPT_TIMEOUT_MS` (fail-fast at startup)                                                                                                                                                                                                                      |
| Agent events enabled       | `AGENT_EVENTS_ENABLED`           | `true`                          | Agent lifecycle events through the telemetry bridge to evlog; fail-soft when disabled or on writer errors. PostHog is enabled separately by its token. Accepts only `true`/`false` (empty → default); legacy `1`/`yes`/`TRUE` fail startup.                                                                                                                       |
| Agent events retention     | `AGENT_EVENTS_RETENTION_SECONDS` | `2592000`                       | TTL delete for `agent_feedback` rows by `created_at` (30d, same as work retention). `0` keeps rows forever.                                                                                                                                                                                                                                                       |
| Models catalog path        | `MODELS_JSON_PATH`               | empty                           | optional absolute/relative path to Pi `models.json`; when empty, looks for `models.json` at `process.cwd()` (Docker: `/app/models.json`)                                                                                                                                                                                                                          |
| PostHog token              | `POSTHOG_PROJECT_TOKEN`          | empty                           | optional analytics and AI traces; empty token sends nothing and opens no trace client. Product events stay metadata. AI traces include credential-redacted repository text. Failed sink construction restores a no-op sink. OSS installs need no PostHog setup.                                                                                                   |
| PostHog host               | `POSTHOG_HOST`                   | empty                           | optional host override when token is set; empty uses posthog-node default                                                                                                                                                                                                                                                                                         |

## Ops (deployment-varying tuning)

`REVIEW_RECOVERY_ENABLED` is not a setting. A process that still has the name
in its environment boots, and the name is not read. Every review resumes from
its durable task checkpoint. See
[rollout](operations.md#review-reliability-rollout).

`REVIEW_TESTS_EVIDENCE` defaults to `false` and maps to `cfg.review.testsEvidence`.
It accepts only `true` or `false`. Empty uses the default, and `1`, `yes`, or
`TRUE` fail startup with `config.invalid_enum`. It is not a `FEATURE_*` mode.
When it is `true`, each tests coverage-gap `read` path must have a content
read recorded by that specialist. Path checks apply either way. A sensitive path is
rejected even when the pull request changes it.

`REVIEW_CHECK_FAIL_SEVERITY` defaults to `P2` and maps to
`cfg.review.checkFailSeverity`. Allowed values are `P0`, `P1`, `P2`, and `P3`.
Open findings at that rank or stricter fail the check. `P3` fails only when
the threshold is `P3`. An empty string is not the default. It throws
`config.invalid_enum`. There is no `off` value.

Review progress lives in the `reviewOrchestratorTask` checkpoint in
`pi_durable.sqlite`, not in `app_state.sqlite`. It goes away with the next
`pi_durable.sqlite` reset, which runs only when no task is live.

`AGENT_EVENTS_ENABLED` and `POSTHOG_PROJECT_TOKEN` are independent. Neither
decides whether a review keeps its task checkpoint.

AI traces are independent of agent events. They require
`POSTHOG_PROJECT_TOKEN`, and webhook intake does not emit them. Each event is
at most 1 MiB after redaction. The process queues at most
400 spans and 8 MiB, and flushes every 500 ms. A full queue, or an event that
still does not fit, sends the event metadata-only through a separate reserve of
50 events and 64 KiB. Past that reserve the event is dropped and logged. Neither
path blocks agent work.
GitHub tokens, npm tokens, provider keys, and database URLs that include a
password are redacted before send. Content can still contain proprietary
code. These limits are private constants in `src/traces/recorder.ts`, not env
knobs.

| Name                          | Env var                              | Default                     | Notes                                                                                                                                                                                                                                          |
| ----------------------------- | ------------------------------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider prompt timeout       | `PROVIDER_PROMPT_TIMEOUT_MS`         | `300000`                    | inactivity cap: abort if no provider activity this long                                                                                                                                                                                        |
| Specialist timeout            | `REVIEW_SPECIALIST_TIMEOUT_MS`       | `140000`                    | total wall-clock budget for one specialist, including jitter, retries, and validation repair; the effective deadline is the smallest of this knob, `REVIEW_SPECIALISTS_BUDGET_MS`, and the remaining attempt model window                      |
| Slash command allowlist       | `SLASH_ALLOWED_ASSOCIATIONS`         | `OWNER,MEMBER,COLLABORATOR` | comma-separated GitHub comment author associations allowed to run slash commands; valid values: `OWNER`, `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`, `NONE`, `MANNEQUIN`; set `*` to allow all           |
| Maintainer decision allowlist | `MAINTAINER_DECISION_ASSOCIATIONS`   | `OWNER,MEMBER,COLLABORATOR` | comma-separated GitHub author associations whose non-bot inline replies may support a dismissal; missing user or association metadata fails closed; `*` is not allowed                                                                         |
| Review concurrency            | `REVIEW_CONCURRENCY`                 | `2`                         | dispatcher slots for `review` work runs                                                                                                                                                                                                        |
| Ask concurrency               | `ASK_CONCURRENCY`                    | `1`                         | dispatcher slots for `ask` work runs; same-mention deduplication comes from ask intake, not this knob                                                                                                                                          |
| Ask actor outstanding         | `ASK_ACTOR_MAX_OUTSTANDING`          | `2`                         | maximum queued or running asks for one actor in one installation                                                                                                                                                                               |
| Ask repository outstanding    | `ASK_REPOSITORY_MAX_OUTSTANDING`     | `8`                         | maximum queued or running asks for one repository                                                                                                                                                                                              |
| Ask installation outstanding  | `ASK_INSTALLATION_MAX_OUTSTANDING`   | `32`                        | maximum queued or running asks across one installation                                                                                                                                                                                         |
| Ask actor burst               | `ASK_ACTOR_BURST`                    | `3`                         | token-bucket burst capacity for one actor                                                                                                                                                                                                      |
| Ask repository burst          | `ASK_REPOSITORY_BURST`               | `12`                        | token-bucket burst capacity for one repository                                                                                                                                                                                                 |
| Ask installation burst        | `ASK_INSTALLATION_BURST`             | `48`                        | token-bucket burst capacity for one installation                                                                                                                                                                                               |
| Ask actor refill              | `ASK_ACTOR_REFILL_SECONDS`           | `60`                        | seconds per actor token                                                                                                                                                                                                                        |
| Ask repository refill         | `ASK_REPOSITORY_REFILL_SECONDS`      | `10`                        | seconds per repository token                                                                                                                                                                                                                   |
| Ask installation refill       | `ASK_INSTALLATION_REFILL_SECONDS`    | `1`                         | seconds per installation token                                                                                                                                                                                                                 |
| Ask provider budget           | `ASK_PROVIDER_BUDGET_TOKENS`         | `0`                         | installation-wide token budget per window; counts each distinct ask computation once; `0` disables this check                                                                                                                                  |
| Ask provider window           | `ASK_PROVIDER_BUDGET_WINDOW_SECONDS` | `86400`                     | provider budget window in seconds; the window rolls on wall-clock time even while reservations are outstanding                                                                                                                                 |
| Ask provider reservation      | `ASK_PROVIDER_RESERVATION_TOKENS`    | `16384`                     | per-ask reservation when the provider does not report usage; must not exceed an enabled provider budget                                                                                                                                        |
| Description concurrency       | `DESCRIPTION_CONCURRENCY`            | `1`                         | dispatcher slots for `description` work runs                                                                                                                                                                                                   |
| Triage concurrency            | `TRIAGE_CONCURRENCY`                 | `1`                         | dispatcher slots for `triage` work runs                                                                                                                                                                                                        |
| Verification concurrency      | `VERIFICATION_CONCURRENCY`           | `1`                         | dispatcher slots for `verification` work runs                                                                                                                                                                                                  |
| Ack concurrency               | `ACK_CONCURRENCY`                    | `2`                         | dispatcher slots for `ack` (reactions and progress stub) and `ci_projection` work runs                                                                                                                                                         |
| Installation group cap        | `INSTALLATION_GROUP_CONCURRENCY`     | `2`                         | per-installation cap on concurrently running work runs                                                                                                                                                                                         |
| Work run retry limit          | `QUEUE_RETRY_LIMIT`                  | `3`                         | each work run admits at most `QUEUE_RETRY_LIMIT + 1` attempts (`work_run_attempts` rows); lifecycle claims and boot reconciliation are free                                                                                                    |
| Work run retry delay          | `QUEUE_RETRY_DELAY_SECONDS`          | `30`                        | first `retry_scheduled` backoff; later retries back off exponentially                                                                                                                                                                          |
| Work run retry delay max      | `QUEUE_RETRY_DELAY_MAX_SECONDS`      | `300`                       | cap on the `retry_scheduled` backoff                                                                                                                                                                                                           |
| Shutdown grace                | `SHUTDOWN_GRACE_MS`                  | `25000`                     | on SIGTERM/SIGINT, `/webhooks` returns 503 and in-flight GitHub writes get this long (ms) to settle before the harness, `app_state.sqlite`, and the lock close. Keep Compose `stop_grace_period` at least 5 s above it                         |
| pi_durable reset size         | `PI_DURABLE_RESET_MAX_BYTES`         | `2147483648`                | zero-503 reset threshold for `pi_durable.sqlite` (2 GiB). See [the reset runbook](agent-work-ops.md#pi_durable-reset)                                                                                                                          |
| pi_durable reset age          | `PI_DURABLE_RESET_MAX_AGE_SECONDS`   | `2592000`                   | zero-503 reset threshold by file age (30 days)                                                                                                                                                                                                 |
| Webhook event retention       | `WEBHOOK_EVENTS_RETENTION_SECONDS`   | `2592000`                   | delete aged `webhook_deliveries`, `webhook_body_replays`, and `webhook_rejections` rows, each by its own `created_at` (30d); disabled scheduled retention leaves evidence unpurged                                                             |
| Agent work retention          | `AGENT_WORK_RETENTION_SECONDS`       | `2592000`                   | delete terminal `work_runs` (and their attempts), old ask quota rows, CI state without active work, and settled `publish_intents` older than this; also bounds same-mention ask deduplication, since the retained ask run is the join evidence |
| Retention schedule            | `RETENTION_CRON`                     | `17 3 * * *`                | cron for the daily `app_state.sqlite` cleanup, followed by `PRAGMA wal_checkpoint(TRUNCATE)`                                                                                                                                                   |
| Retention enabled             | `RETENTION_ENABLED`                  | `true`                      | toggle the scheduled cleanup sweep. Accepts only `true`/`false` (empty → default); legacy `1`/`yes`/`TRUE` fail startup.                                                                                                                       |
| Log level                     | `LOG_LEVEL`                          | `info`                      |                                                                                                                                                                                                                                                |
| Pretty logs                   | `LOG_PRETTY`                         | dev `true`, prod `false`    | Accepts only `true`/`false` (empty → default); legacy `1`/`yes`/`TRUE` fail startup.                                                                                                                                                           |
| Redact logs                   | `LOG_REDACT`                         | `true`                      | scrub secret-shaped substrings from emitted logs. Accepts only `true`/`false` (empty → default); legacy `1`/`yes`/`TRUE` fail startup.                                                                                                         |

Former env tuning knobs (tool-round caps, byte limits, timeouts, anchor-menu
caps, CI-summary waits, workspace limits) are now code constants in
`src/settings/*Constants.ts` — see the tables below.

Progress ownership conflicts use the existing `warn` log level. No new setting
is required. See [work run health](agent-work-ops.md#inspect-work-run-health).

### Project `models.json` (optional Pi catalog)

`loadConfig()` resolves an optional Pi `models.json` catalog path (strict subset parsed in [`src/agent/runtime/durable/modelsJson.ts`](../src/agent/runtime/durable/modelsJson.ts)). The process validates that `PI_PROVIDER` / `PI_MODEL` (and orchestrator/fallback pairs when set) resolve against built-ins ∪ that file before boot opens `/webhooks`. Selection stays in env; the file is only the catalog.

**Resolution order**

1. `MODELS_JSON_PATH` when set (must exist; absolute or cwd-relative).
2. Else `models.json` at `process.cwd()` (Docker image workdir: `/app/models.json`).

- Missing catalog → today’s env + built-in provider path (`modelsJsonPath: null`). A non-built-in `PI_PROVIDER` fails startup with an error that includes the path that was looked for.
- Present but invalid, or selection not found → `loadConfig()` throws and the process exits.
- Prefer `$ENV_VAR` / `${ENV_VAR}` for `apiKey` values. Sample: [`models.json.example`](../models.json.example). Do not commit a real API-key-bearing catalog; keep injection operator-side. Model `cost` fields are USD per 1M tokens (`input` / `output` / `cacheRead` / `cacheWrite`). Use `0` only for free local models; billed proxies need real rates so cache accounting is not silently free.
- **How the file reaches Docker `/app/models.json`:**
  - **Build context:** if repo-root `models.json` exists at `docker build` time (e.g. Dokploy patch), the image copies it to `/app/models.json`. Missing file → build succeeds, no catalog in the image.
  - **Runtime mount:** add `./models.json:/app/models.json:ro` yourself. The committed compose file does not. Create the host file first. A missing path becomes a directory.
  - **Override path:** set `MODELS_JSON_PATH` when the catalog is not at cwd.

### External model provider secrets

Loaded by `loadConfig()` into a redaction-safe map and never logged. Set the secret(s) for your `PI_PROVIDER`.

| Env var                        | Purpose                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`               | OpenAI provider                                                                                               |
| `ANTHROPIC_API_KEY`            | Anthropic provider                                                                                            |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google provider. If empty, pi-ai also reads `GEMINI_API_KEY` from the process environment. Either name works. |

### Custom model providers

Point `PI_PROVIDER` at a `models.json` key to use an OpenAI-compatible proxy or a local server. Copy [`models.json.example`](../models.json.example) and keep the file operator-side. Never commit a real API key.

Pi reference (upstream `earendil-works/pi`):

- Custom models and catalog format, with Ollama and proxy examples: [packages/coding-agent/docs/models.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md).
- Built-in provider catalog code: [packages/ai](https://github.com/earendil-works/pi/tree/main/packages/ai).
- Provider extensions (`registerProvider`, OAuth flows): [packages/coding-agent/docs/custom-provider.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/custom-provider.md). Those are code extensions, not catalog entries, so they do not apply to the `models.json` below.

Base provider fields (parsed in [`src/agent/runtime/durable/modelsJson.ts`](../src/agent/runtime/durable/modelsJson.ts)):

| Field        | Required | Notes                                                                                                                                   |
| ------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`    | Yes      | Server URL, for example `https://llm.example.com/v1` or `http://localhost:11434/v1`                                                     |
| `api`        | Yes      | Request shape; see known values below                                                                                                   |
| `apiKey`     | Yes      | Plain value, a dummy like `ollama` for keyless local servers, or a whole-value `$VAR` / `${VAR}` template resolved from the process env |
| `authHeader` | No       | Set `true` when the server expects the key as an `Authorization` header                                                                 |
| `headers`    | No       | Extra per-request headers                                                                                                               |
| `compat`     | No       | Request-shape flags for every model on the provider; see `compat` shape below                                                           |
| `models`     | Yes      | Non-empty array; see model fields below                                                                                                 |

Model fields (every entry is an object; `models` must be a non-empty array):

| Field              | Type                    | Default    | Notes                                                            |
| ------------------ | ----------------------- | ---------- | ---------------------------------------------------------------- |
| `id`               | non-empty string        | required   | Model id sent to the server                                      |
| `name`             | non-empty string        | the `id`   | Display name only                                                |
| `reasoning`        | boolean                 | `false`    | Set `true` for reasoning-capable models so thinking levels apply |
| `input`            | `["text"]` / image list | `["text"]` | Non-empty array of `text` and `image`                            |
| `contextWindow`    | positive number         | `128000`   | Context window in tokens                                         |
| `maxTokens`        | positive number         | `16384`    | Max output tokens per request                                    |
| `cost`             | cost object             | all zeros  | USD per 1M tokens; use `0` only for free local models            |
| `compat`           | compat object           | none       | Per-model flags, merged over the provider `compat`               |
| `thinkingLevelMap` | level map               | none       | Maps PR Agent thinking levels to the model's own effort values   |

`cost` shape: `{ "input": 0.15, "output": 0.6, "cacheRead": 0.075, "cacheWrite": 0.1875 }`. Each rate is a non-negative number; missing entries default to `0`. Billed proxies need real rates or cache accounting stays silently free.

`compat` shape: `{ "supportsDeveloperRole": false, "supportsReasoningEffort": false }`. Every flag is an optional boolean. Some OpenAI-compatible servers (Ollama, vLLM, SGLang) do not understand the `developer` role or `reasoning_effort`; set the flags to `false` so Pi sends a `system` message and skips the effort parameter instead.

`anthropic-messages` providers also accept `forceAdaptiveThinking`, `supportsTemperature`, `supportsStrictTools`, `supportsMidConvoEffort`, `supportsMidConvoSystemMessages`, and `supportsMidConvoToolChanges`. Pi reads them as the matching Anthropic Messages capabilities. Claude models that accept only adaptive thinking (Opus 4.7 and later) need `"forceAdaptiveThinking": true` and `"supportsTemperature": false` when a gateway serves them under a `models.json` entry; otherwise Pi sends budget thinking and a temperature the model rejects. With `forceAdaptiveThinking`, transcript compaction also drops thinking blocks from the turns it keeps, because those blocks are bound to the prefix that compaction rewrites.

`thinkingLevelMap` shape: `{ "high": "high", "xhigh": "max", "minimal": null }`. Keys are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. A string value is sent as the model's effort; `null` marks the level unsupported, so PR Agent clamps to the nearest supported level. `PI_THINKING_CEILING` still caps the level before mapping.

`headers` shape: a flat object of string values, for example `{ "X-Project": "reviews" }`. Values are literal; only `apiKey` expands `$VAR` / `${VAR}`.

Provider `api` selects the request shape. Known values include `openai-completions`, `openai-responses`, `anthropic-messages`, `google-generative-ai`, `azure-openai-responses`, `openai-codex-responses`, `mistral-conversations`, `bedrock-converse-stream`, `google-vertex`, and `pi-messages`. PR Agent accepts any non-empty string here; the Pi runtime decides support when the first session starts.

Local server (Ollama). Only `id` is required per model, and the key is a dummy because Ollama ignores it:

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "compat": { "supportsDeveloperRole": false, "supportsReasoningEffort": false },
      "models": [{ "id": "llama3.1:8b" }, { "id": "qwen2.5-coder:7b" }]
    }
  }
}
```

```bash
PI_PROVIDER=ollama
PI_MODEL=qwen2.5-coder:7b
```

Fully specified model (billed proxy with real rates and image input):

```json
{
  "providers": {
    "my-proxy": {
      "baseUrl": "https://llm.example.com/v1",
      "api": "openai-completions",
      "apiKey": "$MY_PROXY_API_KEY",
      "authHeader": true,
      "headers": { "X-Project": "reviews" },
      "models": [
        {
          "id": "internal-model",
          "name": "Internal Model",
          "reasoning": false,
          "input": ["text", "image"],
          "contextWindow": 128000,
          "maxTokens": 16384,
          "cost": { "input": 0.15, "output": 0.6, "cacheRead": 0.075, "cacheWrite": 0.1875 }
        }
      ]
    }
  }
}
```

Anthropic-compatible endpoint. Same fields, different `api` shape:

```json
{
  "providers": {
    "anthropic-gateway": {
      "baseUrl": "https://gateway.example.com/anthropic",
      "api": "anthropic-messages",
      "apiKey": "${GATEWAY_API_KEY}",
      "models": [{ "id": "gateway-model", "contextWindow": 200000, "maxTokens": 8192 }]
    }
  }
}
```

```bash
PI_PROVIDER=anthropic-gateway
PI_MODEL=gateway-model
GATEWAY_API_KEY=secret
```

Minimal example (OpenAI-compatible proxy):

```json
{
  "providers": {
    "my-proxy": {
      "baseUrl": "https://llm.example.com/v1",
      "api": "openai-completions",
      "apiKey": "$MY_PROXY_API_KEY",
      "authHeader": true,
      "models": [{ "id": "internal-model", "contextWindow": 128000, "maxTokens": 16384 }]
    }
  }
}
```

Required env next to the catalog:

```bash
PI_PROVIDER=my-proxy
PI_MODEL=internal-model
MY_PROXY_API_KEY=secret
```

Strict-subset notes. PR Agent parses a subset of the Pi catalog, and unknown fields throw (`unknown field <section>.<key>`). `oauth`, `modelOverrides`, `samplingParams`, and `promptCache` are not accepted; drop them from the file. `api` and `baseUrl` live on the provider only; per-model overrides of them are not accepted. Per-model `compat` and `thinkingLevelMap` are accepted (see above). `apiKey` templates are whole-value only: `$VAR` or `${VAR}`. Inline mixing and shell execution are not supported. The process validates the selection at boot. Deliver the file with one of the three paths above (build-context copy, runtime mount, or `MODELS_JSON_PATH`).

Verification:

1. Recreate the pr-agent container so it picks up the catalog and env.
2. Boot passes without a `models_json` or selection error.
3. Open a small test PR and comment `/ask` as an allowed association. An answer proves the provider serves requests.
4. `provider.model_not_found` means the provider and model pair was not found; check the spelling of `PI_PROVIDER` and `PI_MODEL` against the catalog.

---

Work run retries are scheduled only by `src/state/workRuns.ts` (`retry_scheduled` with `next_retry_at` from `QUEUE_RETRY_DELAY_SECONDS`, backing off exponentially up to `QUEUE_RETRY_DELAY_MAX_SECONDS`). Each dispatcher claim of a due row inserts one `work_run_attempts` row; the total stays `QUEUE_RETRY_LIMIT + 1`. An attempt interrupted before the provider is not refunded. At the cap, recovery-only completion is allowed; another fresh admission fails with `agent_work.attempts_exhausted`. Boot Phase A adoption and projection never charge an attempt. Deterministic missing-submit/report failures keep their existing single escalated replay when budget permits.

Completed mutation recovery without a usable result is terminal before budget
exhaustion. Failed or incomplete evidence reads remain transient, and genuine failure budgets
and defaults are unchanged. There is no separate unknown-resolution knob.

---

## Code constants (`src/settings/*Constants.ts`, re-exported via `constants.ts`)

### Agent work

| Symbol                                       | Value / role                                                                                                                                                                                                |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEFERRED_HEAD_SHA`                          | the work run resolves the head SHA at execution                                                                                                                                                             |
| `AUTOMATED_PR_ACTIONS`                       | opened, synchronize, reopened, closed — accepted intake actions, not the auto-enqueue map; effective close cancels reviews and persists a closed/merged intake gate; only a newer reopen restores admission |
| `REVIEW_TRUSTED_AUTHOR_ASSOCIATIONS`         | `OWNER`, `MEMBER`, `COLLABORATOR`; trusted fork authors reviewed on open in approval mode (see [features.md](features.md))                                                                                  |
| `REVIEW_WORKFLOW_START_UNGATED_ASSOCIATIONS` | `CONTRIBUTOR`, `NONE`, `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`; a fork author with one of those associations waits for a pull request approval or `/review`. A workflow start does not admit that row       |
| `DESCRIPTION_PUBLISH_LENS`                   | `description`                                                                                                                                                                                               |
| `ASK_PUBLISH_LENS`                           | `ask`                                                                                                                                                                                                       |
| `TRIAGE_PUBLISH_LENS`                        | `triage`                                                                                                                                                                                                    |
| `VERIFICATION_PUBLISH_LENS`                  | `verification`                                                                                                                                                                                              |
| `VERIFICATION_STUB_MARKER`                   | `<!-- pr-agent:verification-stub -->` HTML marker in the single verification stub reply per finding thread                                                                                                  |
| `VERIFICATION_FAILURE_START` / `_END`        | Start `<!-- pr-agent:verification-failure -->`. End `<!-- /pr-agent:verification-failure -->`.                                                                                                              |
| `VERIFICATION_FAILURE_TEXT`                  | `Verification did not complete. Run \`/verify\` to try again.`                                                                                                                                              |
| `publish_records.step` extras                | `ci_cell`, `commit_status`, `verification_failure` — CHECK values reserved for later writers                                                                                                                |
| `MAX_STORED_COMMENT_TEXT_LEN`                | 16384                                                                                                                                                                                                       |
| `ESCALATED_TOOL_ROUNDS_MULTIPLIER`           | 2, factor applied to a base structured-loop tool-round budget on an escalated attempt (attempt 2 and later)                                                                                                 |
| `ESCALATED_TOOL_ROUNDS_CAP`                  | 4000, ceiling on any escalated tool-round budget                                                                                                                                                            |

### Review output

Concurrent attempts to finish a review keep the first verdict, including acknowledgement and recovery. No new setting is required. A disabled commit status or an empty/deferred head needs no status write.

Review check runs are configured on, but optional installation access determines
their applicability for each run. When Checks write is available, the review
starts `PR Agent Review` as `in_progress`. Enabled `FEATURE_COMMIT_STATUS`
independently starts `pr-agent/review` as `pending` when status write is available.
A remote check belongs to `(owner, repo, head SHA, name, external ID)`, with the
work run ID as external ID. Duplicate recovery requires exactly one full-identity
match. Every terminal path uses `reviewVerdict(...).close`.
Full coverage concludes `failure` for open findings at or above
`REVIEW_CHECK_FAIL_SEVERITY` (default `P2`) and `success` when none block.
`P3` fails only when the threshold is `P3`. Partial coverage uses check
`neutral` and status `error` unless an open finding is already at or above
that threshold, in which case it is published failure, status `failure`, and
GitHub review `REQUEST_CHANGES`.
Cancellation, supersession, and stale-head replacement use check `cancelled`;
crash/unpublished uses `action_required`. Their statuses use `error`.
Commit-status keys remain per state (`review:commit_status:<resource>:<head>:<state>`).
Selected output is immutable. Surface state separately records applied,
skipped-for-this-run, blocked, or unresolved. Never-started optional surfaces
can be skipped; accepted or acceptance-uncertain effects stay applicable for
independent repair. Status recovery does not require a successful Checks read.

Fresh repository-specific installation preflight needs PR/content reads and
review/comment publication for new review work, not Contents write. Comments
and labels accept Issues or Pull requests grants at their endpoint's level.
Optional Checks/statuses reads and writes, Actions logs, all managed labels,
and reactions are run-scoped. Unknown CI-source reads stop after three persisted
failures per observation; a newer review observation reopens them. Repository
observation fanout touches at most 100 existing scoped heads per transaction;
projection repair discovers the remainder. A two-second total budget bounds metadata plus a
required cold mint/refresh. Unknown failures retry within the work run's
`QUEUE_RETRY_LIMIT + 1` attempt budget, without model calls or
escalation. Shared-circuit deferral spends no probe count. No new environment
flag is required. Receipt-only completion precedes new-output access checks.
See [rollout](operations.md#review-reliability-rollout).

Operators using branch protection must replace required checks named `PR Agent Security Review`, `PR Agent Quality Review`, or `PR Agent Tests Review` with `PR Agent Review`. New runs no longer create the three old check names.

| Symbol                                                                                                                                             | Role                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REVIEW_SUMMARY_SENTINEL`                                                                                                                          | PR conversation summary marker                                                                                                                        |
| `LEGACY_REVIEW_SUMMARY_SENTINELS`                                                                                                                  | Historical review summary markers retained for recognition                                                                                            |
| `REVIEW_POINTER_BODY`                                                                                                                              | Legacy Files-tab stub copy retained for recognition                                                                                                   |
| `LEGACY_REVIEW_POINTER_BODIES`                                                                                                                     | Historical files-tab pointer text retained for recognition                                                                                            |
| `REVIEW_POINTER_NOTE_LEAD`                                                                                                                         | Legacy first-publish pointer NOTE body retained for recognition                                                                                       |
| `REVIEW_SIZES`                                                                                                                                     | Review size scale (`XS`–`XXL`) for the Size row and `size:` label                                                                                     |
| `REVIEW_OVERVIEW_ALERT` / `REVIEW_FAILURE_ALERT`                                                                                                   | GitHub alert types (`NOTE`, `CAUTION`)                                                                                                                |
| `REVIEW_PROGRESS_NOTE`                                                                                                                             | In-progress NOTE body                                                                                                                                 |
| `REVIEW_PROGRESS_QUEUED_NOTE`                                                                                                                      | Queued progress stub NOTE body (before the dispatcher claims the work run)                                                                            |
| `REVIEW_PROGRESS_QUEUE_LABEL`                                                                                                                      | Queued progress stub table label for wait-queue rank (`Queue`)                                                                                        |
| `reviewProgressCancelledNote` / `reviewCancelLastError` / `reviewCancelAttributionForClosedPr` / `sanitizeGithubLogin` / `ReviewCancelAttribution` | Cancelled progress stub notice, work-item last_error, closed-PR attribution, and login sanitizer                                                      |
| `REVIEW_PROGRESS_SOURCE_AUTO` / `REVIEW_PROGRESS_SOURCE_SLASH`                                                                                     | Progress table source labels                                                                                                                          |
| `LIGHTWEIGHT_REVIEW_COMPLETION_*`                                                                                                                  | Docs-only auto-review skip copy                                                                                                                       |
| `OWN_COMMIT_STATUS_CONTEXT`                                                                                                                        | `pr-agent/review` — own commit status context excluded from head CI facts                                                                             |
| `CI_STATE_MAX_CHECKS`                                                                                                                              | 200 — max named checks stored on one `pr_head_ci_state` row; overflow drops the oldest other check                                                    |
| `REVIEW_CI_SUMMARY_MAX_FAILURES`                                                                                                                   | 3 — max failing checks named in the facts-only CI headline                                                                                            |
| `REVIEW_CI_SUMMARY_LOG_MAX_BYTES` / `REVIEW_CI_SUMMARY_LOG_PER_JOB_MAX_CHARS` / `REVIEW_CI_SUMMARY_LOG_MAX_JOBS`                                   | 24000 / 12000 / 3 — condensed Actions log caps for the CI-summary LLM call                                                                            |
| `REVIEW_CI_SUMMARY_LOG_RAW_TAIL_MULTIPLE`                                                                                                          | 4 — raw log intake window is this many times the per-job char budget                                                                                  |
| `REVIEW_CI_SUMMARY_HEADLINE_MAX_CHARS` / `REVIEW_CI_SUMMARY_REASON_MAX_CHARS` / `REVIEW_CI_SUMMARY_FIX_HINT_MAX_CHARS`                             | 240 / 400 / 280 — model-authored CI field caps                                                                                                        |
| `REVIEW_CI_SUMMARY_GRANT_CHECKS` / `REVIEW_CI_SUMMARY_GRANT_ACTIONS` / `REVIEW_CI_SUMMARY_UNAVAILABLE`                                             | User-visible CI-row copy when Checks/Actions permission is missing, or status fetch fails                                                             |
| `REVIEW_CI_SUMMARY_INCOMPLETE`                                                                                                                     | CI-row copy when the retrieved check-run page is incomplete                                                                                           |
| `REVIEW_SIZE_TIER_*`                                                                                                                               | Advisory small/medium/large tier thresholds                                                                                                           |
| `REVIEW_RISK_PATH_PATTERNS`                                                                                                                        | Path categories for trusted review context                                                                                                            |
| `REVIEW_FINDING_FOOTNOTE_INLINE` / `REVIEW_FINDING_FOOTNOTE_SUMMARY` / `REVIEW_FINDING_FOOTNOTE_SUMMARY_P3`                                        | Finding row footnotes (P3 summary-only points at Fix all)                                                                                             |
| `REVIEW_FINDINGS_NONE`                                                                                                                             | Empty findings table cell                                                                                                                             |
| `AGENT_FIX_PROMPT_ACCORDION_SUMMARY`                                                                                                               | Review summary accordion title for the aggregate agent fix prompt                                                                                     |
| `MAX_REVIEW_FOLLOW_UPS`                                                                                                                            | 5                                                                                                                                                     |
| `REVIEW_FINDING_TITLE_MAX_CHARS`                                                                                                                   | 80                                                                                                                                                    |
| `REVIEW_FINDING_DETAIL_MAX_CHARS`                                                                                                                  | 4000                                                                                                                                                  |
| `REVIEW_FINDING_FIX_PROMPT_MAX_CHARS`                                                                                                              | 2000                                                                                                                                                  |
| `REVIEW_FINDING_SUGGESTED_CODE_MAX_CHARS`                                                                                                          | 2000                                                                                                                                                  |
| `REVIEW_FOLLOW_UP_MAX_CHARS`                                                                                                                       | 2000                                                                                                                                                  |
| `REVIEW_GATE_PROSE_MAX_CHARS`                                                                                                                      | 280 — shared Mergeability and Blast Radius line cap                                                                                                   |
| `REVIEW_FINDING_SEVERITY_RATIONALE_MAX_CHARS`                                                                                                      | 280 — published severity rationale cap, same length as gate prose                                                                                     |
| `REVIEW_GATE_PROSE_UNASSESSED`                                                                                                                     | `Not assessed.` — internal marker when synthesis did not supply gate prose; a completed summary replaces it from the changed-file list before publish |
| `REVIEW_SUMMARY_BODY_MAX_CHARS`                                                                                                                    | 60000                                                                                                                                                 |
| `REVIEW_SUMMARY_COMPACTION_NOTE`                                                                                                                   | Public note when summary is compacted                                                                                                                 |
| `REVIEW_SUMMARY_FINDINGS_OMITTED_SUFFIX`                                                                                                           | Public note when finding rows are omitted                                                                                                             |
| `MAX_REVIEW_PAYLOAD_FINDINGS`                                                                                                                      | 128                                                                                                                                                   |
| `MAX_SPECIALIST_FINDINGS`                                                                                                                          | 20 findings per specialist report                                                                                                                     |
| `MAX_INLINE_REVIEW_COMMENTS`                                                                                                                       | 50                                                                                                                                                    |
| `MAX_THREAD_PUBLISH_CALLS`                                                                                                                         | 8 incremental COMMENT reviews per orchestrated run; the terminal close-outcome review is extra                                                        |
| `REVIEW_FINALIZATION_WINDOW_MS`                                                                                                                    | 30000 reserved after model work for abort, durable writes, summary, checks, status, and labels                                                        |
| `REVIEW_SEVERITY_RANK`                                                                                                                             | P0–P3 ordering                                                                                                                                        |
| Label prefixes                                                                                                                                     | `LABEL_REVIEW_SIZE_PREFIX`, `LABEL_SECURITY_CONCERN`, `LABEL_CATEGORY_PREFIX`                                                                         |
| `REPO_POLICY_DIRNAME`                                                                                                                              | `.pr-agent` directory at checkout root                                                                                                                |
| `REPO_POLICY_EXTENSION`                                                                                                                            | `.mdc`                                                                                                                                                |
| `MAX_REPO_POLICY_BYTES`                                                                                                                            | 32768 (aggregate content across accepted rules)                                                                                                       |
| `MAX_REPO_POLICY_FILE_BYTES`                                                                                                                       | 8192                                                                                                                                                  |
| `MAX_REPO_POLICY_FILES`                                                                                                                            | 20                                                                                                                                                    |
| `MAX_REPO_POLICY_PATH_PATTERN_CHARS`                                                                                                               | 200                                                                                                                                                   |
| `MAX_REPO_POLICY_INSTRUCTION_CHARS`                                                                                                                | 1000                                                                                                                                                  |
| `AGENT_INSTRUCTION_FILENAMES`                                                                                                                      | `AGENTS.md`, `CLAUDE.md`, `REVIEW.md` (repo-root load order)                                                                                          |
| `MAX_AGENT_INSTRUCTION_BYTES`                                                                                                                      | 65536 (aggregate content across accepted root files)                                                                                                  |
| `MAX_AGENT_INSTRUCTION_FILE_BYTES`                                                                                                                 | 32768                                                                                                                                                 |

A running attempt observes durable cancellation through its abort signal and at
each task-phase boundary (`attemptIsCurrent` rereads the work run and its
attempt row). `publishOnce` also rereads the work run status and lane epoch
inside the `reserved → mutating` transaction. This adds no knob and blocks new
feature output when cancellation is visible. Cancellation notices and verdict
cleanup keep their exemption; requests already in flight cannot be withdrawn.

A failed stale review's pending replacement is cancelled even if its claim wins
concurrently; the dispatcher's claim and the cancellation share one
`work_runs` row and the sole status writer. Unconfirmed cancellation is logged
as an error.

Stale-head replacement creation reads lifecycle state in the same transaction.
Accepted close/merge blocks replacement work and progress ownership transfer.
This adds no mode, setting or polling interval.
------------------ | ------------------ | --------------------- | ------------------------------------------------------------------------------------------------- |
| `globs` | string or string[] | 200 chars per pattern | Include rule when a changed file matches; omit with no `alwaysApply` to always apply |
| `alwaysApply` | boolean | optional | `true` always includes the rule; omit both keys to always apply; `false` requires a matching glob |
| body | markdown | 1000 chars | Rule prose from the base snapshot, injected as trusted policy when the rule applies |

Legacy `.pr-agent.yml` is ignored. Rules augment prompts only. They never replace the structured specialist and summary contracts or change output schemas. No policy body may suppress, omit, or downgrade findings.

#### Root agent instruction files (`AGENTS.md` / `CLAUDE.md` / `REVIEW.md`)

On each review run, the review loads `AGENTS.md`, `CLAUDE.md`, and `REVIEW.md` from the recorded base commit into a sibling trusted-context block. Head copies are untrusted proposed changes and are not binding. The per-file cap is 32768 bytes and the aggregate cap stays 64 KiB. Missing files are skipped and are not cited; oversized, unreadable, or empty files are skipped (warn logged). Bodies are injected raw — `@include` / pointer expansion is not performed. Ask, describe, and triage do not load these files. Verification reads `.mdc` rules from the same base snapshot and does not load these instruction files. Review prompts mention `AGENTS.md`, `CLAUDE.md`, or `REVIEW.md` only when that file was loaded.

`REVIEW.md` holds review-only guidance, the convention other review agents read from the repository root. It loads last, so an existing `AGENTS.md` or `CLAUDE.md` keeps its budget; when the aggregate cap is already spent, `REVIEW.md` is skipped with a warning. Its instructions follow the same anti-suppression rule as every trusted file: they can add checks, but they cannot skip paths, suppress, omit, or downgrade findings.

Example:

```mdc
---
globs:
  - "src/auth/**"
alwaysApply: false
---

Treat missing session checks as P1 minimum. Flag any new outbound HTTP without timeout.
```

### Review orchestration and agent loops

An orchestrated review computes its hard return deadline from the attempt start as `REVIEW_ATTEMPT_BUDGET_MS` (255000: 10000 intake/checkout + 40000 recon + 140000 specialists + 35000 synthesis/publish + 30000 finalization reserve). Model work stops `REVIEW_FINALIZATION_WINDOW_MS` before that deadline, and reconnaissance additionally stops at the intake + recon budget point. Each specialist attempt uses the smallest of `REVIEW_SPECIALIST_TIMEOUT_MS`, `REVIEW_SPECIALISTS_BUDGET_MS`, and the remaining model window. A specialist that hits `REVIEW_SPECIALIST_WRAP_UP_MS` (105000) or `REVIEW_SPECIALIST_WRAP_UP_TOOL_ROUNDS` (75% of `SPECIALIST_MAX_TOOL_ROUNDS`) gets a wrap-up steer turn bounded by the remaining tool rounds (`SPECIALIST_MAX_TOOL_ROUNDS` minus the investigation rounds already sent) to finish in-flight validation and call `submit_findings_report`, and can return a `partial` outcome; `complete`, `partial`, and `failed` are the specialist outcome kinds, and specialists auto-compact long sessions.

| Symbol                                       | Default / role                                                                                                                                                  |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RECON_MAX_TOOL_ROUNDS`                      | 15 for orchestrator reconnaissance                                                                                                                              |
| `SPECIALIST_MAX_TOOL_ROUNDS`                 | 30 for specialist investigation. The specialist timeout, the wrap-up steer, and the review deadline stop the run first                                          |
| `GOVERNED_EVIDENCE_MAX_READS`                | 2000 governed evidence reads per review run                                                                                                                     |
| `ORCHESTRATOR_JUDGMENT_MAX_TOOL_ROUNDS`      | 4 evidence rounds per specialist judgment turn, plus one reserved publish round (at most one extra round; evidence gathering can never starve `publish_thread`) |
| `MAX_PR_FILES_LISTED`                        | 300, within the GitHub API cap                                                                                                                                  |
| `MAX_PR_FILES_PATCH_BYTES`                   | 500000                                                                                                                                                          |
| `REVIEW_ANCHOR_MENU_MAX_RANGES_PER_FILE`     | 20                                                                                                                                                              |
| `MAX_TOOL_ROUNDS_TRIAGE`                     | 32                                                                                                                                                              |
| `MAX_TOOL_ROUNDS_VERIFICATION`               | 32                                                                                                                                                              |
| `MAX_ESCALATED_VERIFICATION_INVENTORY`       | 10 oldest open findings re-checked by an escalated verification attempt; the rest waits for a later run                                                         |
| `VERIFICATION_OBJECTION_ANSWER_MAX_CHARS`    | 800 characters in one objection answer body. Not an environment variable.                                                                                       |
| `VERIFICATION_MAX_OBJECTION_ANSWERS_PER_RUN` | 8 oldest finding objections answered in one verification run. Not an environment variable.                                                                      |
| `MAX_TRIAGE_FIXES_PER_RUN`                   | 10                                                                                                                                                              |
| `MAX_ASK_TOOL_ROUNDS`                        | 12                                                                                                                                                              |
| `MAX_ASK_FINALIZE_ROUNDS`                    | 2                                                                                                                                                               |
| `SESSION_CACHE_ID_MAX_LENGTH`                | 64 — OpenAI-style `prompt_cache_key` clamp for Pi session ids                                                                                                   |
| `SESSION_TURN_RETRY_MAX`                     | 1 — Core `runAgentLoopContinue` after a retryable assistant error with no admitted tool from that turn                                                          |
| `SESSION_TURN_RETRY_BASE_DELAY_MS`           | 250 — base delay before the first turn retry; doubles on each later retry                                                                                       |
| `SESSION_OVERFLOW_COMPACT_MAX`               | 1 — compact-and-continue after a context-overflow assistant error; a second overflow is terminal                                                                |
| `VALIDATION_REPAIR_ROUNDS`                   | 3                                                                                                                                                               |
| `SUBMIT_ONLY_MAX_TOOL_ROUNDS`                | 2 per submit-only turn (repair, synthesis, summary recovery); not scaled by escalation                                                                          |
| `PUBLISH_RECOVERY_ROUNDS`                    | 2 summary recovery sends                                                                                                                                        |
| `ReviewValidationFailureKind`                | Validation failure metric categories                                                                                                                            |
| `ReviewPhase`                                | Review metric categories                                                                                                                                        |

### Description

Writing policy is computed once per description run from workspace size stats (`fileCount`, `totalChanges`, truncated). It sets **body scale** (bullet range, words per bullet, technical depth) and **map mode** together. Prompt prose lives in `src/agent/description/`; numeric limits stay here.

| Symbol                                    | Default / role                                                                                      |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `MAX_TOOL_ROUNDS_DESCRIBE`                | 16                                                                                                  |
| `DESCRIPTION_MAP_OMIT_MAX_FILES`          | 5 — S body scale + omit map when at or under this file count (and line-change bound, not truncated) |
| `DESCRIPTION_MAP_OMIT_MAX_LINE_CHANGES`   | 300 — S body scale + omit map when under this total line changes                                    |
| `DESCRIPTION_MAP_MAX_ENTRIES`             | 5 — publish cap for review-map `prFiles`                                                            |
| `MAX_DESCRIPTION_PAYLOAD_PR_FILES`        | 20 — schema ceiling so enforce can cap-and-publish                                                  |
| `DESCRIPTION_BODY_M_MAX_FILES`            | 20 — M body scale upper file bound; above becomes L                                                 |
| `DESCRIPTION_BODY_M_MAX_LINE_CHANGES`     | 1500 — M body scale upper line-change bound; at or above becomes L                                  |
| `DESCRIPTION_BODY_S_BULLET_MIN` / `_MAX`  | 2 / 5                                                                                               |
| `DESCRIPTION_BODY_S_MAX_WORDS_PER_BULLET` | 25                                                                                                  |
| `DESCRIPTION_BODY_M_BULLET_MIN` / `_MAX`  | 4 / 8                                                                                               |
| `DESCRIPTION_BODY_M_MAX_WORDS_PER_BULLET` | 30                                                                                                  |
| `DESCRIPTION_BODY_L_BULLET_MIN` / `_MAX`  | 6 / 12                                                                                              |
| `DESCRIPTION_BODY_L_MAX_WORDS_PER_BULLET` | 35                                                                                                  |
| `DESCRIPTION_AGENT_BODY_BEGIN` / `_END`   | HTML markers wrapping the agent description block in the PR body                                    |
| `DESCRIPTION_AGENT_HEADER`                | `## PR Agent Description`                                                                           |
| `DESCRIPTION_REVIEW_MAP_HEADING`          | `### Review map`                                                                                    |

### Triage

| Symbol                               | Default / role                                      |
| ------------------------------------ | --------------------------------------------------- |
| `TRIAGE_SUMMARY_SENTINEL`            | `## PR Agent Triage`                                |
| `TRIAGE_PREVIEW_SENTINEL`            | `## PR Agent Triage Preview`                        |
| `TRIAGE_UNKNOWN_SUBCOMMAND`          | unknown `/triage` subcommand ack                    |
| `TRIAGE_INVALID_EXCLUDE`             | `/triage all exclude` missing or non-digit ids ack  |
| `TRIAGE_BULK_REQUIRES_PREVIEW`       | `/triage all` without a preview on this PR          |
| `TRIAGE_BULK_PREVIEW_STALE`          | `/triage all` after the head moved since preview    |
| `TRIAGE_BULK_PARTIAL_NOTICE`         | bulk report notice when some findings failed        |
| `TRIAGE_ALREADY_IN_PROGRESS`         | duplicate `/triage` ack text                        |
| `TRIAGE_FAILURE_MESSAGE`             | terminal failure PR comment                         |
| `TRIAGE_NO_ELIGIBLE_FINDINGS`        | no triage-eligible unresolved findings report text  |
| `TRIAGE_THREAD_NOT_ELIGIBLE`         | scoped thread not in inventory ack/report text      |
| `TRIAGE_FULL_RUN_IN_PROGRESS`        | thread `/triage` while full-PR triage active ack    |
| `TRIAGE_INLINE_USAGE_HINT`           | top-level inline `/triage` usage hint               |
| `TRIAGE_ALL_PRIOR_FINDINGS_RESOLVED` | resolved-only inventory report text                 |
| `TRIAGE_FORK_PR_NOTICE`              | fork PR report-only text                            |
| `TRIAGE_STALE_HEAD_NOTICE`           | stale push report text                              |
| `TRIAGE_THREAD_RESOLUTION_NOTICE`    | missing thread mapping report text                  |
| `TRIAGE_VALIDATION_REPAIR_ROUNDS`    | 3                                                   |
| `TRIAGE_PRE_SUBMIT_NUDGE_ROUNDS`     | 2                                                   |
| `MAX_TRIAGE_FINDINGS`                | 128                                                 |
| `TRIAGE_VERDICT_EVIDENCE_MAX_CHARS`  | 500                                                 |
| `TRIAGE_SKIP_REASON_MAX_CHARS`       | 300                                                 |
| `TRIAGE_COMMIT_SUBJECT_MAX_CHARS`    | 50                                                  |
| `TRIAGE_COMMIT_TYPES`                | feat, fix, refactor, docs, test, chore, style, perf |
| `TRIAGE_COMMIT_BODY_MAX_BULLETS`     | 5                                                   |
| `TRIAGE_COMMIT_MAX_FILES`            | 20                                                  |
| `TRIAGE_MAX_COMMIT_DIFF_LINES`       | 200                                                 |
| `TRIAGE_NEW_FILE_MAX_BYTES`          | 32768                                               |

### Ask safety

`MAX_ASK_THREAD_TRANSCRIPT_CHARS` is the character ceiling for the shared ask and verification discussion block.

| Symbol                            | Default                                                                                                                                                                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAX_ASK_QUESTION_CHARS`          | 8192                                                                                                                                                                                                                             |
| `MAX_ASK_THREAD_TRANSCRIPT_CHARS` | 24000                                                                                                                                                                                                                            |
| `ASK_META_REFUSAL`                | meta-probe reply                                                                                                                                                                                                                 |
| `BOT_META_PATTERNS`               | regex set                                                                                                                                                                                                                        |
| `BOT_SECRET_PATTERNS`             | outbound redaction for auth headers, provider keys, JWTs, and secret-shaped tokens                                                                                                                                               |
| `SENSITIVE_PATH_PATTERNS`         | shared sensitive-path policy for ask reads, verification search, and triage reads, search, writes, staging, and commits                                                                                                          |
| `TRIAGE_CONTROL_PATH_PATTERNS`    | control-plane paths, including every `.jsonc` file at any depth and case, blocked by triage workspace reads, search, writes, staging, and commits, and by verification search. Lives in `src/agent/triage/triageWritePolicy.ts`. |

### GitHub API

| Symbol                                    | Default                                            |
| ----------------------------------------- | -------------------------------------------------- |
| `TOKEN_FRESHNESS_BUFFER_MS`               | 60000                                              |
| `INSTALLATION_TOKEN_FALLBACK_TTL_MS`      | 1h                                                 |
| `PRIMARY_RATE_LIMIT_MAX_RETRIES`          | 2                                                  |
| `SECONDARY_RATE_LIMIT_MAX_RETRIES`        | 3                                                  |
| `SHARED_RATE_LIMIT_CIRCUIT_COOLDOWN_MS`   | 60000                                              |
| `GITHUB_PULL_REQUEST_FILES_API_MAX_FILES` | 3000                                               |
| `COMMENTS_PAGE_SIZE`                      | 100                                                |
| `COMMENT_PAGINATION_MAX_PAGES`            | 20                                                 |
| `CHECK_RUNS_PAGE_SIZE`                    | 100                                                |
| `CHECK_RUNS_MAX_PAGES`                    | 5                                                  |
| `PR_COMMITS_PAGE_SIZE`                    | 100                                                |
| `PR_COMMITS_MAX_PAGES`                    | 20                                                 |
| `GITHUB_REACTION_EYES`                    | eyes                                               |
| `GITHUB_REACTION_PLUS_ONE`                | +1                                                 |
| `GITHUB_REACTION_MINUS_ONE`               | -1                                                 |
| `GITHUB_INT32_ID_MAX`                     | 2147483647 (PR numbers; GitHub 32-bit integer IDs) |
| `GITHUB_SAFE_ID_MAX`                      | 9007199254740991 (installation/comment/user ids)   |
| `GITHUB_LOGIN_MAX_CHARS`                  | 39                                                 |
| `GITHUB_REPO_NAME_MAX_CHARS`              | 100                                                |
| `GITHUB_SHA_MAX_CHARS`                    | 64                                                 |

### Local PR workspace

| Symbol                                           | Default                |
| ------------------------------------------------ | ---------------------- |
| `LOCAL_WORKSPACE_GREP_PATHSPEC_CHUNK_SIZE`       | 256                    |
| `LOCAL_WORKSPACE_FFF_SCAN_TIMEOUT_MS`            | 10000                  |
| `LOCAL_WORKSPACE_FFF_CALL_TIMEOUT_MS`            | 20000                  |
| `LOCAL_WORKSPACE_FFF_GREP_TIME_BUDGET_MS`        | 5000                   |
| `LOCAL_WORKSPACE_FFF_GREP_PAGE_FILES`            | 200                    |
| `LOCAL_WORKSPACE_FFF_MAX_COLLECTED_MATCHES`      | 10000                  |
| `LOCAL_WORKSPACE_FFF_MAX_INDEXED_FILES`          | 200000                 |
| `LOCAL_WORKSPACE_FFF_MAX_LIVE_INDEXES`           | 8                      |
| `LOCAL_WORKSPACE_FFF_MAX_FILE_BYTES`             | 10485760               |
| `LOCAL_WORKSPACE_FFF_RESPAWN_BACKOFF_MS`         | 30000                  |
| `LOCAL_WORKSPACE_TREE_WALK_CONCURRENCY`          | 32                     |
| `PR_REPOSITORY_VIEW_RELEASE_GRACE_MS`            | 60000                  |
| `LOCAL_WORKSPACE_CLONE_TIMEOUT_MS`               | 60000                  |
| `LOCAL_WORKSPACE_FETCH_TIMEOUT_MS`               | 60000                  |
| `LOCAL_WORKSPACE_FETCH_LOW_SPEED_LIMIT_BYTES`    | 1000                   |
| `LOCAL_WORKSPACE_FETCH_LOW_SPEED_TIME_SECONDS`   | 20                     |
| `LOCAL_WORKSPACE_GIT_KILL_GRACE_MS`              | 2000                   |
| `LOCAL_WORKSPACE_GIT_KILL_CONFIRM_MS`            | 1000                   |
| `LOCAL_WORKSPACE_GIT_GROUP_POLL_MS`              | 50                     |
| `LOCAL_WORKSPACE_GIT_MAX_BUFFER_BYTES`           | 20971520               |
| `LOCAL_WORKSPACE_GIT_STDERR_DIAGNOSTIC_CHARS`    | 1000                   |
| `LOCAL_WORKSPACE_SEARCH_MAX_FILES`               | 500                    |
| `LOCAL_WORKSPACE_MAX_FILE_BYTES`                 | 1000000                |
| `LOCAL_WORKSPACE_SEARCH_MAX_TOTAL_BYTES`         | 50000000               |
| `LOCAL_WORKSPACE_SEARCH_MAX_TERMS`               | 8                      |
| `LOCAL_WORKSPACE_SEARCH_TERM_MAX_MATCHES`        | 200                    |
| `LOCAL_WORKSPACE_MAX_DIFF_BYTES`                 | 5000000                |
| `LOCAL_WORKSPACE_READ_RESPONSE_BYTES`            | 128000                 |
| `LOCAL_WORKSPACE_READ_MAX_LINE_CHARACTERS`       | 2000                   |
| `LOCAL_WORKSPACE_DIFF_RESPONSE_BYTES`            | 256000                 |
| `LOCAL_WORKSPACE_MIN_FREE_SPACE_BYTES`           | 500000000              |
| `LOCAL_WORKSPACE_MAX_FETCH_BYTES`                | 2147483648             |
| `LOCAL_WORKSPACE_FULL_CLONE_MAX_REPO_KB`         | 1000000                |
| `LOCAL_WORKSPACE_STALE_CLEANUP_AGE_SECONDS`      | 3600                   |
| `LOCAL_WORKSPACE_SYMBOL_INDEX_BUILD_TIMEOUT_MS`  | 5000                   |
| `LOCAL_WORKSPACE_SYMBOL_INDEX_MAX_SYMBOLS`       | 50000                  |
| `LOCAL_WORKSPACE_SYMBOL_INDEX_MAX_RESULTS`       | 50                     |
| `LOCAL_WORKSPACE_SYMBOL_INDEX_READ_CONCURRENCY`  | 16                     |
| `LOCAL_WORKSPACE_READ_MAX_PATH_SUGGESTIONS`      | 5                      |
| `LOCAL_WORKSPACE_PATH_SUGGESTION_MIN_SIMILARITY` | 0.6                    |
| `READ_SPILL_FILENAME_PREFIX`                     | `pr-agent-read-spill-` |

Pinned searches run on the fff host with `git grep` for the remainder; writable triage searches use `git grep` alone. The `LOCAL_WORKSPACE_FFF_*` constants bound the host: scan and request deadlines, the paging budget, the indexed-file cap above which a checkout skips fff, live indexes per host, the file size fff reads, and the respawn backoff after a host dies. Both paths apply `LOCAL_WORKSPACE_SEARCH_MAX_TOTAL_BYTES` to the result and the tool `maxResults` after parse. A buffer cut returns partial results with `truncated: true`, not proof of absence. Those limits do not use Git 2.40 `--max-count`. Debian bookworm Git 2.39.x in the application image is enough.

### Code Mode

| Symbol                                 | Default |
| -------------------------------------- | ------- |
| `CODE_MODE_MAX_TOOL_CALLS`             | 25      |
| `CODE_MODE_HOST_IN_FLIGHT`             | 4       |
| `CODE_MODE_SERIALIZE_MAX_ARRAY_LENGTH` | 100     |
| `CODE_MODE_SERIALIZE_MAX_STRING_BYTES` | 32768   |
| `CODE_MODE_HOST_TO_GUEST_MAX_BYTES`    | 262144  |

Review, ask, and verification expose one model-visible `execute` tool. Scripts call canonical workspace capabilities as `tools.*`. Terminal submit and publish tools stay native siblings. Each call is one QuickJS cell in the `@earendil-works/pi-codemode` runtime: fresh context, the last expression returns, and `fetch`, `require`, `import`, `process`, `fs`, and timers are unavailable.

### Removed settings

`CODE_INDEX_MODE`, `CODE_INDEX_WAIT_MS`, and `CODE_INDEX_RETENTION_SECONDS` are not settings.

### Other

The `SLASH_*` rows below live in `src/state/intake.ts` as private owner
settings, not barrel exports.

| Symbol                                              | Role                                                                   |
| --------------------------------------------------- | ---------------------------------------------------------------------- |
| `MAX_LOG_MESSAGE_LEN`                               | 2000                                                                   |
| `MAX_LOG_REDACTION_SCAN_LEN`                        | 8000                                                                   |
| `SLASH_HELP_BODY`                                   | `/help` text                                                           |
| `SLASH_CANCEL_NONE_BODY` / `SLASH_CANCEL_DONE_BODY` | `/cancel` ack replies when no review is active / after cancel          |
| `SLASH_REVIEW_ALREADY_IN_PROGRESS_BODY`             | `/review` ack reply when a run is already active                       |
| `SLASH_VERIFY_ALREADY_IN_PROGRESS_BODY`             | `/verify` ack reply when a run is already active                       |
| `SLASH_REVIEW_FORCE_RESTARTED_BODY`                 | `/review force` ack reply after a force restart                        |
| `GITHUB_WEBHOOK_RESPONSE_MARGIN_MS`                 | 2000ms margin before GitHub's webhook timeout                          |
| `WEBHOOK_MAX_BODY_BYTES`                            | 25000000 (GitHub payload cap)                                          |
| `WEBHOOK_TIMEOUT_MS`                                | 10000 (intake 503 budget)                                              |
| `LOG_MAX_WIDE_EVENTS`                               | 128                                                                    |
| `ANALYTICS_SHUTDOWN_TIMEOUT_MS`                     | 5000 (PostHog flush bound during shutdown, inside `SHUTDOWN_GRACE_MS`) |

Prompt prose lives in `src/prompts/shared/` and `src/prompts/<role>/prompt.ts`, including review personas and description prose.

Private specialist orchestration constants (not exported from `src/settings/`): `INITIAL_JITTER_MAX_MS` (`3000`) and `RETRY_BACKOFF_BASE_MS` (`500`) live in `src/review/orchestrator/specialistRun.ts`.

### Removed session snapshot settings

`AGENT_RESUME_SNAPSHOT_KEY` and `AGENT_RESUME_SNAPSHOT_MARGIN_SECONDS` are ignored.
Conversations persist in `pi_durable.sqlite`; work runs, publish intents, and
publish records in `app_state.sqlite` own retries and publication recovery.

### Removed with the SQLite cutover

The role, database, queue, lease, and drain settings of the previous topology
are gone. `SQLITE_DIR` replaces the database URL and `SHUTDOWN_GRACE_MS`
replaces the drain budget. The full list is in the
[cutover runbook](operations.md#one-time-clean-break-cutover-runbook).
