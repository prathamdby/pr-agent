# Configuration catalog

Deployment wiring (infra) and operator tuning (ops) for **pr-agent**. The
user-facing settings are the eight `FEATURE_*` vars — see
[features.md](features.md); they are not repeated here. Code defaults live in
[`src/settings/`](../src/settings/); env vars are loaded in
[`src/config.ts`](../src/config.ts).

For behaviour, deployment, and developer scripts see [operations.md](operations.md). Agent index: [AGENTS.md](../AGENTS.md).

## How to change something

| Kind         | Where to edit                                                                  |
| ------------ | ------------------------------------------------------------------------------ |
| **feature**  | `.env` → `FEATURE_*` keys; catalog and semantics in [features.md](features.md) |
| **env**      | `.env` / deployment env → keys below; defaults in `src/settings/defaults.ts`   |
| **code**     | `src/settings/constants.ts`                                                    |
| **external** | Provider env; loaded into config but never logged                              |

Import convention: `import { … } from "../settings/index.js"` for constants; `Config` from `config.ts` at runtime.

### When you change a knob

| Change                       | Update                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------- |
| New or changed feature       | `featureModes.ts`, `envKeys.ts`, `config.ts`, `.env.example`, `docs/features.md`  |
| New or renamed env var       | `envKeys.ts`, `defaults.ts`, `config.ts`, `.env.example`, `docs/configuration.md` |
| New or changed code constant | `constants.ts`, `docs/configuration.md`                                           |
| Default value only           | `defaults.ts`, `.env.example` (if documented there), `docs/configuration.md`      |

Do not add magic numbers or env default strings in feature modules; import from `src/settings/`.

CI enforces env alignment via `test/settingsInventory.test.ts` (including that every `FEATURE_*` key appears in `docs/features.md`). `docs/configuration.md` code-constant rows are maintained on the honor system.

---

## Infra (required wiring and provider selection)

| Name                              | Env var                                  | Default                  | Notes                                                                                                                                                                                                                                       |
| --------------------------------- | ---------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP port                         | `PORT`                                   | `3000` (7224 in Compose) |                                                                                                                                                                                                                                             |
| Process role                      | `ROLE`                                   | `web`                    | `web` or `worker`                                                                                                                                                                                                                           |
| GitHub App ID                     | `GITHUB_APP_ID`                          | —                        | required                                                                                                                                                                                                                                    |
| App private key                   | `GITHUB_APP_PRIVATE_KEY`                 | —                        | required PEM                                                                                                                                                                                                                                |
| Webhook HMAC secret               | `WEBHOOK_SECRET`                         | —                        | required                                                                                                                                                                                                                                    |
| Postgres URL                      | `DATABASE_URL`                           | —                        | required                                                                                                                                                                                                                                    |
| General LLM provider              | `PI_PROVIDER`                            | `openai`                 | Primary model provider for Specialist, Ask, Description, Triage, Verification, and CI-summary sessions (built-in slug or `models.json` key)                                                                                                 |
| General LLM model                 | `PI_MODEL`                               | `gpt-4o-mini`            | Primary model id for general sessions                                                                                                                                                                                                       |
| Orchestrator provider             | `PI_ORCHESTRATOR_PROVIDER`               | empty                    | Optional override for Review orchestrator sessions; empty inherits `PI_PROVIDER`                                                                                                                                                            |
| Orchestrator model                | `PI_ORCHESTRATOR_MODEL`                  | empty                    | Optional override for Review orchestrator sessions; empty inherits `PI_MODEL`                                                                                                                                                               |
| Fallback provider                 | `PI_FALLBACK_PROVIDER`                   | empty                    | Optional shared fallback provider; must be set with `PI_FALLBACK_MODEL`. Used only after availability-class retry exhaustion                                                                                                                |
| Fallback model                    | `PI_FALLBACK_MODEL`                      | empty                    | Optional shared fallback model; empty disables fallback                                                                                                                                                                                     |
| Thinking ceiling                  | `PI_THINKING_CEILING`                    | `high`                   | Max thinking level for phase-aware thinking (`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`)                                                                                                                                           |
| Resume snapshot key               | `AGENT_RESUME_SNAPSHOT_KEY`              | empty                    | Base64 32-byte key for encrypted Agent resume snapshots; empty disables snapshot persistence                                                                                                                                                |
| Resume snapshot margin            | `AGENT_RESUME_SNAPSHOT_MARGIN_SECONDS`   | `600`                    | Extra TTL seconds beyond queue retry window for resume snapshot retention                                                                                                                                                                   |
| Agent events enabled              | `AGENT_EVENTS_ENABLED`                   | `true`                   | Persist metadata-only agent lifecycle and decision/publish events to `agent_events`; fail-soft when disabled or on writer errors. Accepts only `true`/`false` (empty → default); legacy `1`/`yes`/`TRUE` fail startup.                      |
| Agent events retention            | `AGENT_EVENTS_RETENTION_SECONDS`         | `0`                      | Optional TTL delete for `agent_events` by `recorded_at`; `0` relies on `AGENT_WORK_RETENTION_SECONDS` + `ON DELETE SET NULL` on `work_item_id`                                                                                              |
| Finding history enabled           | `FINDING_HISTORY_ENABLED`                | `true`                   | Persist cross-PR fingerprint outcomes to `repo_finding_history`; fail-soft when disabled or on writer errors. Accepts only `true`/`false` (empty → default); legacy `1`/`yes`/`TRUE` fail startup.                                          |
| Finding history dismiss threshold | `FINDING_HISTORY_DISMISS_SUPPRESS_AFTER` | `3`                      | After this many dismissals for a fingerprint, suppress new inline threads while `last_outcome` remains `dismissed` (summary-only still allowed); later open/fixed outcomes lift suppression                                                 |
| Finding history lookback          | `FINDING_HISTORY_LOOKBACK_DAYS`          | `180`                    | Ignore `repo_finding_history` rows older than this when loading suppression candidates                                                                                                                                                      |
| Code index mode                   | `CODE_INDEX_MODE`                        | `off`                    | `off` disables Postgres FTS hints; `fts` enables optional navigation index (hints only — `readWorkspaceFile` still required for publish)                                                                                                    |
| Code index wait                   | `CODE_INDEX_WAIT_MS`                     | `3000`                   | Max wait during review setup for a ready `code_index_snapshots` row at the PR head SHA                                                                                                                                                      |
| Code index retention              | `CODE_INDEX_RETENTION_SECONDS`           | `2592000`                | Delete superseded/failed/ready `code_index_snapshots` older than this (cascades `code_index_chunks`)                                                                                                                                        |
| Models catalog path               | `MODELS_JSON_PATH`                       | empty                    | optional absolute/relative path to Pi `models.json`; when empty, looks for `models.json` at `process.cwd()` (Docker: `/app/models.json`)                                                                                                    |
| Context7 API key                  | `CONTEXT7_API_KEY`                       | empty                    | optional; sent only in `Authorization` for policy-approved requests, otherwise Context7 uses anonymous fallback                                                                                                                             |
| PostHog token                     | `POSTHOG_PROJECT_TOKEN`                  | empty                    | optional analytics via `src/analytics` facade; empty token disables init (no SDK load, no capture). Failed sink construction, including reinitialization, restores a no-op sink with analytics disabled. OSS installs need no PostHog setup |
| PostHog host                      | `POSTHOG_HOST`                           | empty                    | optional host override when token is set; empty uses posthog-node default                                                                                                                                                                   |

## Ops (deployment-varying tuning)

| Name                          | Env var                                   | Default                     | Notes                                                                                                                                                                                                                                |
| ----------------------------- | ----------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Provider prompt timeout       | `PROVIDER_PROMPT_TIMEOUT_MS`              | `300000`                    | inactivity cap: abort if no provider activity this long                                                                                                                                                                              |
| Specialist timeout            | `REVIEW_SPECIALIST_TIMEOUT_MS`            | `900000`                    | total wall-clock budget for one specialist, including jitter, retries, and validation repair                                                                                                                                         |
| Slash command allowlist       | `SLASH_ALLOWED_ASSOCIATIONS`              | `OWNER,MEMBER,COLLABORATOR` | comma-separated GitHub comment author associations allowed to run slash commands; valid values: `OWNER`, `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`, `NONE`, `MANNEQUIN`; set `*` to allow all |
| Maintainer decision allowlist | `MAINTAINER_DECISION_ASSOCIATIONS`        | `OWNER,MEMBER,COLLABORATOR` | comma-separated GitHub author associations whose non-bot inline replies may support a dismissal; missing user or association metadata fails closed; `*` is not allowed                                                               |
| Review worker concurrency     | `REVIEW_CONCURRENCY`                      | `2`                         | pg-boss review queue workers                                                                                                                                                                                                         |
| Ask worker concurrency        | `ASK_CONCURRENCY`                         | `1`                         | pg-boss ask queue workers                                                                                                                                                                                                            |
| Ask actor outstanding         | `ASK_ACTOR_MAX_OUTSTANDING`               | `2`                         | maximum queued or running asks for one actor in one installation                                                                                                                                                                     |
| Ask repository outstanding    | `ASK_REPOSITORY_MAX_OUTSTANDING`          | `8`                         | maximum queued or running asks for one repository                                                                                                                                                                                    |
| Ask installation outstanding  | `ASK_INSTALLATION_MAX_OUTSTANDING`        | `32`                        | maximum queued or running asks across one installation                                                                                                                                                                               |
| Ask actor burst               | `ASK_ACTOR_BURST`                         | `3`                         | token-bucket burst capacity for one actor                                                                                                                                                                                            |
| Ask repository burst          | `ASK_REPOSITORY_BURST`                    | `12`                        | token-bucket burst capacity for one repository                                                                                                                                                                                       |
| Ask installation burst        | `ASK_INSTALLATION_BURST`                  | `48`                        | token-bucket burst capacity for one installation                                                                                                                                                                                     |
| Ask actor refill              | `ASK_ACTOR_REFILL_SECONDS`                | `60`                        | seconds per actor token                                                                                                                                                                                                              |
| Ask repository refill         | `ASK_REPOSITORY_REFILL_SECONDS`           | `10`                        | seconds per repository token                                                                                                                                                                                                         |
| Ask installation refill       | `ASK_INSTALLATION_REFILL_SECONDS`         | `1`                         | seconds per installation token                                                                                                                                                                                                       |
| Ask provider budget           | `ASK_PROVIDER_BUDGET_TOKENS`              | `0`                         | installation-wide token budget per window; `0` disables this check                                                                                                                                                                   |
| Ask provider window           | `ASK_PROVIDER_BUDGET_WINDOW_SECONDS`      | `86400`                     | provider budget window in seconds; old reservations keep the window closed until they finish                                                                                                                                         |
| Ask provider reservation      | `ASK_PROVIDER_RESERVATION_TOKENS`         | `16384`                     | per-ask reservation when the provider does not report usage; must not exceed an enabled provider budget                                                                                                                              |
| Description concurrency       | `DESCRIPTION_CONCURRENCY`                 | `1`                         | pg-boss description queue workers                                                                                                                                                                                                    |
| Triage concurrency            | `TRIAGE_CONCURRENCY`                      | `1`                         | pg-boss triage queue workers                                                                                                                                                                                                         |
| Verification concurrency      | `VERIFICATION_CONCURRENCY`                | `1`                         | pg-boss verification queue workers                                                                                                                                                                                                   |
| Ack worker concurrency        | `ACK_CONCURRENCY`                         | `2`                         | reactions + progress stub                                                                                                                                                                                                            |
| Installation group cap        | `INSTALLATION_GROUP_CONCURRENCY`          | `2`                         | pg-boss group policy                                                                                                                                                                                                                 |
| Queue retry limit             | `QUEUE_RETRY_LIMIT`                       | `3`                         | pg-boss job retries                                                                                                                                                                                                                  |
| Queue retry delay             | `QUEUE_RETRY_DELAY_SECONDS`               | `30`                        |                                                                                                                                                                                                                                      |
| Queue retry delay max         | `QUEUE_RETRY_DELAY_MAX_SECONDS`           | `300`                       |                                                                                                                                                                                                                                      |
| Job expire                    | `QUEUE_EXPIRE_IN_SECONDS`                 | `3600`                      |                                                                                                                                                                                                                                      |
| Job heartbeat                 | `QUEUE_HEARTBEAT_SECONDS`                 | `60`                        | min 10                                                                                                                                                                                                                               |
| Queue polling interval        | `QUEUE_POLLING_INTERVAL_SECONDS`          | `0.5`                       | pg-boss worker poll interval in seconds; min 0.5                                                                                                                                                                                     |
| Job retention                 | `QUEUE_RETENTION_SECONDS`                 | `1209600`                   |                                                                                                                                                                                                                                      |
| Job delete after              | `QUEUE_DELETE_AFTER_SECONDS`              | `604800`                    |                                                                                                                                                                                                                                      |
| Shutdown drain budget         | `SHUTDOWN_DRAIN_TIMEOUT_SECONDS`          | `25`                        | graceful pg-boss stop wait (s) on SIGTERM/SIGINT                                                                                                                                                                                     |
| Webhook event retention       | `WEBHOOK_EVENTS_RETENTION_SECONDS`        | `2592000`                   | delete webhook_events and associated body-hash replay rows older than this (30d)                                                                                                                                                     |
| PR actor lease TTL            | `PR_ACTOR_LEASE_TTL_SECONDS`              | `900`                       | lease validity window; a crashed holder's lease becomes stealable after this                                                                                                                                                         |
| PR actor lease renewal        | `PR_ACTOR_LEASE_RENEWAL_INTERVAL_SECONDS` | `120`                       | holder renewal cadence; must be less than `PR_ACTOR_LEASE_TTL_SECONDS` (startup validation)                                                                                                                                          |
| Agent work retention          | `AGENT_WORK_RETENTION_SECONDS`            | `2592000`                   | delete terminal agent_work_items older than this                                                                                                                                                                                     |
| Retention schedule            | `RETENTION_CRON`                          | `17 3 * * *`                | cron for the worker cleanup sweep                                                                                                                                                                                                    |
| Retention enabled             | `RETENTION_ENABLED`                       | `true`                      | toggle the scheduled cleanup sweep. Accepts only `true`/`false` (empty → default); legacy `1`/`yes`/`TRUE` fail startup.                                                                                                             |
| Log level                     | `LOG_LEVEL`                               | `info`                      |                                                                                                                                                                                                                                      |
| Pretty logs                   | `LOG_PRETTY`                              | dev `true`, prod `false`    | Accepts only `true`/`false` (empty → default); legacy `1`/`yes`/`TRUE` fail startup.                                                                                                                                                 |
| Redact logs                   | `LOG_REDACT`                              | `true`                      | scrub secret-shaped substrings from emitted logs. Accepts only `true`/`false` (empty → default); legacy `1`/`yes`/`TRUE` fail startup.                                                                                               |

Former env tuning knobs (tool-round caps, byte limits, timeouts, anchor-menu
caps, CI-summary waits, workspace limits) are now code constants in
`src/settings/*Constants.ts` — see the tables below.

### Project `models.json` (optional Pi catalog)

`loadConfig()` resolves an optional Pi `models.json` catalog path (same shape as `~/.pi/agent/models.json`). **`ROLE=worker`** validates that `PI_PROVIDER` / `PI_MODEL` (and orchestrator/fallback pairs when set) resolve against built-ins ∪ that file before any agent session starts. **`ROLE=web`** only resolves the path and keeps the env selection strings for boot logs — it does not load Pi / `ModelRuntime` (web never creates sessions). Selection stays in env; the file is only the catalog.

**Resolution order**

1. `MODELS_JSON_PATH` when set (must exist; absolute or cwd-relative).
2. Else `models.json` at `process.cwd()` (Docker image workdir: `/app/models.json`).

- Missing catalog → today’s env + built-in provider path (`modelsJsonPath: null`). On **worker**, a non-built-in `PI_PROVIDER` fails with an error that includes the path that was looked for.
- Present but invalid, or selection not found → **worker** `loadConfig()` throws; **web** accepts the env strings without catalog validation.
- Prefer `$ENV_VAR` / `${ENV_VAR}` for `apiKey` values (see [Pi models.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md)). Sample: [`models.json.example`](../models.json.example). Do not commit a real API-key-bearing catalog; keep injection operator-side. Model `cost` fields are USD per 1M tokens (`input` / `output` / `cacheRead` / `cacheWrite`). Use `0` only for free local models; billed proxies need real rates so cache accounting is not silently free.
- **How the file reaches Docker `/app/models.json`:**
  - **Build context:** if repo-root `models.json` exists at `docker build` time (e.g. Dokploy patch), the image copies it to `/app/models.json`. Missing file → build succeeds, no catalog in the image.
  - **Runtime mount:** Compose `./models.json:/app/models.json:ro` (create the host file first — a missing path becomes a directory).
  - **Override path:** set `MODELS_JSON_PATH` when the catalog is not at cwd.

### External model provider secrets

Loaded by `loadConfig()` into a redaction-safe map and never logged. Set the secret(s) for your `PI_PROVIDER`.

| Env var                        | Purpose            |
| ------------------------------ | ------------------ |
| `OPENAI_API_KEY`               | OpenAI provider    |
| `ANTHROPIC_API_KEY`            | Anthropic provider |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google provider    |

---

Work item retries are controlled only by pg-boss (`QUEUE_RETRY_LIMIT`, `QUEUE_RETRY_DELAY_SECONDS`, `QUEUE_RETRY_DELAY_MAX_SECONDS`; exponential backoff is always enabled).

---

## Code constants (`src/settings/*Constants.ts`, re-exported via `constants.ts`)

### Agent work (queues)

| Symbol                                     | Value / role                                                                                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ACK_QUEUE`                                | `agent-work-ack`                                                                                                                                            |
| `CI_REFRESH_QUEUE`                         | `agent-work-ci-refresh` — LLM CI cell refresh after `workflow_run` or `check_suite` completed                                                               |
| `CI_REFRESH_RETRY_DELAY_SECONDS`           | 15, start-after delay when a refresh hits an active review and re-enqueues on the same lane                                                                 |
| `CI_REFRESH_RETRY_ATTEMPT_LIMIT`           | 120, max retain hops after the original delivery (30 minutes at the delay above); exhaustion stops silently                                                 |
| `REVIEW_QUEUE`                             | `agent-work-review`                                                                                                                                         |
| `ASK_QUEUE`                                | `agent-work-ask`                                                                                                                                            |
| `DESCRIPTION_QUEUE`                        | `agent-work-description`                                                                                                                                    |
| `TRIAGE_QUEUE`                             | `agent-work-triage`                                                                                                                                         |
| `VERIFICATION_QUEUE`                       | `agent-work-verification`                                                                                                                                   |
| `ACK_DEAD_LETTER_QUEUE`                    | `agent-work-ack-dead`                                                                                                                                       |
| `REVIEW_DEAD_LETTER_QUEUE`                 | `agent-work-review-dead`                                                                                                                                    |
| `ASK_DEAD_LETTER_QUEUE`                    | `agent-work-ask-dead`                                                                                                                                       |
| `DESCRIPTION_DEAD_LETTER_QUEUE`            | `agent-work-description-dead`                                                                                                                               |
| `TRIAGE_DEAD_LETTER_QUEUE`                 | `agent-work-triage-dead`                                                                                                                                    |
| `VERIFICATION_DEAD_LETTER_QUEUE`           | `agent-work-verification-dead`                                                                                                                              |
| `CI_REFRESH_DEAD_LETTER_QUEUE`             | `agent-work-ci-refresh-dead`                                                                                                                                |
| `RETENTION_QUEUE`                          | `agent-work-retention` — scheduled cleanup sweep                                                                                                            |
| `CODE_INDEX_BUILD_QUEUE`                   | `code-index-build` — optional Postgres FTS index build (when `CODE_INDEX_MODE=fts`)                                                                         |
| `RETENTION_QUEUE_POLLING_INTERVAL_SECONDS` | 60                                                                                                                                                          |
| `DEFERRED_HEAD_SHA`                        | worker resolves head SHA                                                                                                                                    |
| `AUTOMATED_PR_ACTIONS`                     | opened, synchronize, reopened, closed — `pull_request` actions accepted at webhook intake (not the auto-enqueue map); `closed` cancels in-progress reviews  |
| `AUTO_TRIGGER_ACTIONS`                     | feature auto-trigger map: review/describe on `opened`, verification on `synchronize`; `reopened` enqueues nothing (see [features.md](features.md))          |
| `DESCRIPTION_PUBLISH_LENS`                 | `description`                                                                                                                                               |
| `ASK_PUBLISH_LENS`                         | `ask`                                                                                                                                                       |
| `TRIAGE_PUBLISH_LENS`                      | `triage`                                                                                                                                                    |
| `VERIFICATION_PUBLISH_LENS`                | `verification`                                                                                                                                              |
| `VERIFICATION_STUB_MARKER`                 | `<!-- pr-agent:verification-stub -->` HTML marker in the single verification stub reply per finding thread                                                  |
| `MAX_STORED_COMMENT_TEXT_LEN`              | 16384                                                                                                                                                       |
| `RETENTION_DELETE_BATCH_SIZE`              | 5000, rows per batch in the retention sweep (each batch is its own transaction)                                                                             |
| `PR_ACTOR_LEASE_DEFER_SECONDS`             | 15, delay between lease-acquisition attempts for a blocked delivery; the armed redelivery re-checks until the lease frees or lapses                         |
| `STALE_QUEUED_WORK_GRACE_SECONDS`          | 300, age after which a queued leased-type work item with no live lease and no live pg-boss job is logged as `agent_work_queued_stale` (delivery chain dead) |

### Review output

Review check runs are always on. The acknowledgement worker posts `PR Agent Review` on the PR head and starts it as `in_progress`. A remote run belongs to `(owner, repo, head SHA, name, external ID)`, where the external ID is the requesting work-item ID. Duplicate recovery adopts a run only when the provider returns exactly one run with that full identity. Full-coverage runs complete with `failure` for any P0/P1/P2 finding and `success` when findings are empty or P3-only. Partial specialist coverage completes as `neutral`; the optional commit status reports `error`. Slash `/cancel`, close cancel, and worker-observed cancel complete the check as `cancelled` (idempotent if already finished). Checks require GitHub App read/write permission and soft-fail when that permission is missing.

Operators using branch protection must replace required checks named `PR Agent Security Review`, `PR Agent Quality Review`, or `PR Agent Tests Review` with `PR Agent Review`. New runs no longer create the three old check names.

| Symbol                                                                                                                                             | Role                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `REVIEW_SUMMARY_SENTINEL`                                                                                                                          | PR conversation summary marker                                                                                    |
| `LEGACY_REVIEW_SUMMARY_SENTINELS`                                                                                                                  | Historical review summary markers retained for recognition                                                        |
| `REVIEW_POINTER_BODY`                                                                                                                              | Legacy Files-tab stub copy retained for recognition / repeat-no-bugs fallback                                     |
| `LEGACY_REVIEW_POINTER_BODIES`                                                                                                                     | Historical files-tab pointer text retained for recognition                                                        |
| `REVIEW_POINTER_NOTE_LEAD`                                                                                                                         | Legacy first-publish pointer NOTE body retained for recognition                                                   |
| `REVIEW_SIZES`                                                                                                                                     | Review size scale (`XS`–`XXL`) for the Size row and `size:` label                                                 |
| `REVIEW_OVERVIEW_ALERT` / `REVIEW_FAILURE_ALERT`                                                                                                   | GitHub alert types (`NOTE`, `CAUTION`)                                                                            |
| `REVIEW_PROGRESS_NOTE`                                                                                                                             | In-progress NOTE body                                                                                             |
| `REVIEW_PROGRESS_QUEUED_NOTE`                                                                                                                      | Queued progress stub NOTE body (before the review worker claims the work item)                                    |
| `REVIEW_PROGRESS_QUEUE_LABEL`                                                                                                                      | Queued progress stub table label for wait-queue rank (`Queue`)                                                    |
| `reviewProgressCancelledNote` / `reviewCancelLastError` / `reviewCancelAttributionForClosedPr` / `sanitizeGithubLogin` / `ReviewCancelAttribution` | Cancelled progress stub notice, work-item last_error, closed-PR attribution, and login sanitizer                  |
| `REVIEW_PROGRESS_SOURCE_AUTO` / `REVIEW_PROGRESS_SOURCE_SLASH`                                                                                     | Progress table source labels                                                                                      |
| `LIGHTWEIGHT_REVIEW_COMPLETION_*`                                                                                                                  | Docs-only auto-review skip copy                                                                                   |
| `REVIEW_CHECK_RUN_RESERVATION_STALE_MS`                                                                                                            | 300000                                                                                                            |
| `REVIEW_CHECK_RUN_WAIT_FOR_ID_MS` / `REVIEW_CHECK_RUN_WAIT_POLL_MS`                                                                                | 15000 / 100 — poll for a peer-started check run id before giving up                                               |
| `REVIEW_CI_SUMMARY_WAIT_MS` / `REVIEW_CI_SUMMARY_WAIT_POLL_MS` / `REVIEW_CI_SUMMARY_MAX_FAILURES`                                                  | 15000 / 2000 / 3 — CI summary gate wait, poll, and max failing checks                                             |
| `REVIEW_CI_SUMMARY_LOG_MAX_BYTES` / `REVIEW_CI_SUMMARY_LOG_PER_JOB_MAX_CHARS` / `REVIEW_CI_SUMMARY_LOG_MAX_JOBS`                                   | 24000 / 12000 / 3 — condensed Actions log caps for the CI-summary LLM call                                        |
| `REVIEW_CI_SUMMARY_FETCH_CONCURRENCY` / `REVIEW_CI_SUMMARY_LOG_RAW_TAIL_MULTIPLE`                                                                  | 4 / 4 — parallel annotation and job-log fetches; raw log intake window is this many times the per-job char budget |
| `REVIEW_CI_SUMMARY_HEADLINE_MAX_CHARS` / `REVIEW_CI_SUMMARY_REASON_MAX_CHARS` / `REVIEW_CI_SUMMARY_FIX_HINT_MAX_CHARS`                             | 240 / 400 / 280 — model-authored CI field caps                                                                    |
| `REVIEW_CI_SUMMARY_GRANT_CHECKS` / `REVIEW_CI_SUMMARY_GRANT_ACTIONS` / `REVIEW_CI_SUMMARY_UNAVAILABLE`                                             | User-visible CI-row copy when Checks/Actions permission is missing, or status fetch fails                         |
| `REVIEW_SIZE_TIER_*`                                                                                                                               | Advisory small/medium/large tier thresholds                                                                       |
| `REVIEW_RISK_PATH_PATTERNS`                                                                                                                        | Path categories for trusted review context                                                                        |
| `REVIEW_FINDING_FOOTNOTE_INLINE` / `REVIEW_FINDING_FOOTNOTE_SUMMARY` / `REVIEW_FINDING_FOOTNOTE_SUMMARY_P3`                                        | Finding row footnotes (P3 summary-only points at Fix all)                                                         |
| `REVIEW_FINDINGS_NONE`                                                                                                                             | Empty findings table cell                                                                                         |
| `REVIEW_SECURITY_DEFAULT`                                                                                                                          | Default security row when null                                                                                    |
| `AGENT_FIX_PROMPT_ACCORDION_SUMMARY`                                                                                                               | Review summary accordion title for the aggregate agent fix prompt                                                 |
| `MAX_REVIEW_FOLLOW_UPS`                                                                                                                            | 5                                                                                                                 |
| `REVIEW_FINDING_TITLE_MAX_CHARS`                                                                                                                   | 80                                                                                                                |
| `REVIEW_FINDING_DETAIL_MAX_CHARS`                                                                                                                  | 4000                                                                                                              |
| `REVIEW_FINDING_FIX_PROMPT_MAX_CHARS`                                                                                                              | 2000                                                                                                              |
| `REVIEW_FINDING_SUGGESTED_CODE_MAX_CHARS`                                                                                                          | 2000                                                                                                              |
| `REVIEW_OVERVIEW_MAX_CHARS`                                                                                                                        | 8000                                                                                                              |
| `REVIEW_OVERVIEW_COMPACT_MAX_CHARS`                                                                                                                | 500                                                                                                               |
| `REVIEW_SECURITY_CONCERNS_MAX_CHARS`                                                                                                               | 4000                                                                                                              |
| `REVIEW_FOLLOW_UP_MAX_CHARS`                                                                                                                       | 2000                                                                                                              |
| `REVIEW_SUMMARY_BODY_MAX_CHARS`                                                                                                                    | 60000                                                                                                             |
| `REVIEW_SUMMARY_COMPACTION_NOTE`                                                                                                                   | Public note when summary is compacted                                                                             |
| `REVIEW_SUMMARY_FINDINGS_OMITTED_SUFFIX`                                                                                                           | Public note when finding rows are omitted                                                                         |
| `MAX_REVIEW_PAYLOAD_FINDINGS`                                                                                                                      | 128                                                                                                               |
| `MAX_SPECIALIST_FINDINGS`                                                                                                                          | 20 findings per specialist report                                                                                 |
| `MAX_INLINE_REVIEW_COMMENTS`                                                                                                                       | 50                                                                                                                |
| `MAX_THREAD_PUBLISH_CALLS`                                                                                                                         | 8 incremental COMMENT reviews per orchestrated run                                                                |
| `REVIEW_FINALIZATION_WINDOW_MS`                                                                                                                    | 30000 reserved after model work for abort, durable writes, summary, checks, status, and labels                    |
| `REVIEW_CANCEL_POLL_INTERVAL_MS`                                                                                                                   | 2000; how often a running review polls durable cancel state while specialists run                                 |
| `REVIEW_SEVERITY_RANK`                                                                                                                             | P0–P3 ordering                                                                                                    |
| Label prefixes                                                                                                                                     | `LABEL_REVIEW_SIZE_PREFIX`, `LABEL_SECURITY_CONCERN`, `LABEL_CATEGORY_PREFIX`                                     |
| `REVIEW_FINDING_FINGERPRINT_LINE_BUCKET_SIZE`                                                                                                      | 50                                                                                                                |
| `REPO_POLICY_DIRNAME`                                                                                                                              | `.pr-agent` directory at checkout root                                                                            |
| `REPO_POLICY_EXTENSION`                                                                                                                            | `.mdc`                                                                                                            |
| `MAX_REPO_POLICY_BYTES`                                                                                                                            | 32768 (aggregate content across accepted rules)                                                                   |
| `MAX_REPO_POLICY_FILE_BYTES`                                                                                                                       | 8192                                                                                                              |
| `MAX_REPO_POLICY_FILES`                                                                                                                            | 20                                                                                                                |
| `MAX_REPO_POLICY_PATH_PATTERN_CHARS`                                                                                                               | 200                                                                                                               |
| `MAX_REPO_POLICY_INSTRUCTION_CHARS`                                                                                                                | 1000                                                                                                              |
| `AGENT_INSTRUCTION_FILENAMES`                                                                                                                      | `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` (repo-root load order)                                                      |
| `MAX_AGENT_INSTRUCTION_BYTES`                                                                                                                      | 65536 (aggregate content across accepted root files)                                                              |
| `MAX_AGENT_INSTRUCTION_FILE_BYTES`                                                                                                                 | 32768                                                                                                             |

#### Per-repo policy rules (`.pr-agent/*.mdc`)

Flat directory of `.mdc` rule files, read from the PR head checkout at review preflight. Parsing, matching, file-count limits, and byte caps apply before the trust decision. When the PR head and base `repo.full_name` values match, matching rules are binding in `Trusted context (repo policy)`. A fork, missing identity, or malformed identity renders matching rules in `Untrusted context (repo policy from PR head)` inside an untrusted wrapper; those bodies are evidence only and cannot define binding review instructions. Forged trusted/binding headers and policy delimiters are neutralized. Missing directory or zero `.mdc` files means no policy. Unreadable directory, or a directory with candidates but no usable rules, is invalid (warn logged); review proceeds without policy. Oversized or malformed individual files are skipped (warn logged).

| Frontmatter / body | Type               | Cap                   | Role                                                                                              |
| ------------------ | ------------------ | --------------------- | ------------------------------------------------------------------------------------------------- |
| `globs`            | string or string[] | 200 chars per pattern | Include rule when a changed file matches; omit with no `alwaysApply` to always apply              |
| `alwaysApply`      | boolean            | optional              | `true` always includes the rule; omit both keys to always apply; `false` requires a matching glob |
| body               | markdown           | 1000 chars            | Rule prose injected as trusted same-repo policy or untrusted fork evidence when the rule applies  |

Legacy `.pr-agent.yml` is ignored. Rules augment prompts only. They never replace the structured specialist and summary contracts or change output schemas. No policy body may suppress, omit, or downgrade findings.

#### Root agent instruction files (`AGENTS.md` / `CLAUDE.md` / `GEMINI.md`)

On each review run, the worker statically checks the PR head checkout root for these three filenames (in that order). Present regular files from a same-repository head are loaded into a sibling trusted-context block (`Trusted context (agent instruction files):`); fork, missing, or malformed repository identity uses an untrusted wrapper instead. Separate caps apply from repo policy. Missing files are skipped; oversized, unreadable, or empty files are skipped (warn logged). Bodies are injected raw — `@include` / pointer expansion is not performed. Ask, describe, triage, and verification do not load these files.

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

An orchestrated review computes its hard return deadline from the pg-boss job start time as `expireInSeconds * 0.8`. Model work stops `REVIEW_FINALIZATION_WINDOW_MS` before that deadline. Each specialist attempt uses the smaller of `REVIEW_SPECIALIST_TIMEOUT_MS` and the remaining model window.

| Symbol                                   | Default / role                                                  |
| ---------------------------------------- | --------------------------------------------------------------- |
| `MAX_TOOL_ROUNDS`                        | 24 for orchestrator reconnaissance and specialist investigation |
| `ORCHESTRATOR_JUDGMENT_MAX_TOOL_ROUNDS`  | 4 per specialist judgment turn                                  |
| `MAX_REVIEW_PUBLISH_CALLS`               | 2 valid calls for the retained structured review tool contract  |
| `REVIEW_MIN_CONFIDENCE`                  | 1, drop scored findings below this                              |
| `MAX_PR_FILES_LISTED`                    | 300, within the GitHub API cap                                  |
| `MAX_PR_FILES_PATCH_BYTES`               | 500000                                                          |
| `REVIEW_ANCHOR_MENU_MAX_FILES`           | 40                                                              |
| `REVIEW_ANCHOR_MENU_MAX_RANGES_PER_FILE` | 20                                                              |
| `MAX_TOOL_ROUNDS_TRIAGE`                 | 32                                                              |
| `MAX_TOOL_ROUNDS_VERIFICATION`           | 32                                                              |
| `MAX_TRIAGE_FIXES_PER_RUN`               | 10                                                              |
| `MAX_ASK_TOOL_ROUNDS`                    | 12                                                              |
| `MAX_ASK_FINALIZE_ROUNDS`                | 2                                                               |
| `SESSION_CACHE_ID_MAX_LENGTH`            | 64 — OpenAI-style `prompt_cache_key` clamp for Pi session ids   |
| `VALIDATION_REPAIR_ROUNDS`               | 3                                                               |
| `PUBLISH_RECOVERY_ROUNDS`                | 4 summary recovery sends                                        |
| `PUBLISH_BUDGET_EXHAUSTED_MESSAGE`       | Structured review tool guard                                    |
| `REVIEW_DIFF_CACHE_REQUIRED_MESSAGE`     | Structured review diff-cache guard                              |
| `REVIEW_ANCHOR_MENU_BLOCK_LABEL`         | Untrusted anchor menu block label                               |
| `ReviewValidationFailureKind`            | Validation failure metric categories                            |
| `ReviewPhase`                            | Review metric categories                                        |

### Description

Writing policy is computed once per description run from workspace size stats (`fileCount`, `totalChanges`, truncated). It sets **body scale** (bullet range, words per bullet, technical depth) and **map mode** together. Prompt prose lives in `src/agent/description/`; numeric limits stay here.

| Symbol                                           | Default / role                                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `MAX_TOOL_ROUNDS_DESCRIBE`                       | 16                                                                                                |
| `DESCRIPTION_MAP_OMIT_MAX_FILES`                 | 5 — brief body + omit map when at or under this file count (and line-change bound, not truncated) |
| `DESCRIPTION_MAP_OMIT_MAX_LINE_CHANGES`          | 300 — brief body + omit map when under this total line changes                                    |
| `DESCRIPTION_MAP_MAX_ENTRIES`                    | 5 — publish cap for review-map `prFiles`                                                          |
| `MAX_DESCRIPTION_PAYLOAD_PR_FILES`               | 20 — schema ceiling so enforce can cap-and-publish                                                |
| `DESCRIPTION_BODY_STANDARD_MAX_FILES`            | 20 — standard body scale upper file bound; above becomes detailed                                 |
| `DESCRIPTION_BODY_STANDARD_MAX_LINE_CHANGES`     | 1500 — standard body scale upper line-change bound; at or above becomes detailed                  |
| `DESCRIPTION_BODY_BRIEF_BULLET_MIN` / `_MAX`     | 2 / 5                                                                                             |
| `DESCRIPTION_BODY_BRIEF_MAX_WORDS_PER_BULLET`    | 25                                                                                                |
| `DESCRIPTION_BODY_STANDARD_BULLET_MIN` / `_MAX`  | 4 / 8                                                                                             |
| `DESCRIPTION_BODY_STANDARD_MAX_WORDS_PER_BULLET` | 30                                                                                                |
| `DESCRIPTION_BODY_DETAILED_BULLET_MIN` / `_MAX`  | 6 / 12                                                                                            |
| `DESCRIPTION_BODY_DETAILED_MAX_WORDS_PER_BULLET` | 35                                                                                                |
| `DESCRIPTION_AGENT_BODY_BEGIN` / `_END`          | HTML markers wrapping the agent description block in the PR body                                  |
| `DESCRIPTION_AGENT_HEADER`                       | `## PR Agent Description`                                                                         |
| `DESCRIPTION_REVIEW_MAP_HEADING`                 | `### Review map`                                                                                  |

### Triage

| Symbol                               | Default / role                                      |
| ------------------------------------ | --------------------------------------------------- |
| `TRIAGE_SUMMARY_SENTINEL`            | `## PR Agent Triage`                                |
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

| Symbol                            | Default                                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `MAX_ASK_QUESTION_CHARS`          | 8192                                                                                                     |
| `MAX_ASK_THREAD_TRANSCRIPT_CHARS` | 24000                                                                                                    |
| `ASK_META_REFUSAL`                | meta-probe reply                                                                                         |
| `BOT_META_PATTERNS`               | regex set                                                                                                |
| `BOT_SECRET_PATTERNS`             | outbound redaction for auth headers, provider keys, JWTs, and secret-shaped tokens                       |
| `SENSITIVE_PATH_PATTERNS`         | shared sensitive-path policy for ask reads and triage reads, search, writes, staging, and commits        |
| `TRIAGE_CONTROL_PATH_PATTERNS`    | triage-only control-plane paths blocked by workspace reads, search results, writes, staging, and commits |

### GitHub API

| Symbol                                    | Default                                          |
| ----------------------------------------- | ------------------------------------------------ |
| `TOKEN_FRESHNESS_BUFFER_MS`               | 60000                                            |
| `INSTALLATION_TOKEN_FALLBACK_TTL_MS`      | 1h                                               |
| `PRIMARY_RATE_LIMIT_MAX_RETRIES`          | 2                                                |
| `SECONDARY_RATE_LIMIT_MAX_RETRIES`        | 3                                                |
| `SHARED_RATE_LIMIT_CIRCUIT_COOLDOWN_MS`   | 60000                                            |
| `GITHUB_PULL_REQUEST_FILES_API_MAX_FILES` | 3000                                             |
| `COMMENTS_PAGE_SIZE`                      | 100                                              |
| `COMMENT_PAGINATION_MAX_PAGES`            | 20                                               |
| `CHECK_RUNS_PAGE_SIZE`                    | 100                                              |
| `CHECK_RUNS_MAX_PAGES`                    | 5                                                |
| `PR_COMMITS_PAGE_SIZE`                    | 100                                              |
| `PR_COMMITS_MAX_PAGES`                    | 20                                               |
| `GITHUB_REACTION_EYES`                    | eyes                                             |
| `GITHUB_REACTION_PLUS_ONE`                | +1                                               |
| `GITHUB_REACTION_MINUS_ONE`               | -1                                               |
| `GITHUB_INT32_ID_MAX`                     | 2147483647 (PR numbers; Postgres integer)        |
| `GITHUB_SAFE_ID_MAX`                      | 9007199254740991 (installation/comment/user ids) |
| `GITHUB_LOGIN_MAX_CHARS`                  | 39                                               |
| `GITHUB_REPO_NAME_MAX_CHARS`              | 100                                              |
| `GITHUB_SHA_MAX_CHARS`                    | 64                                               |

### Local PR workspace

| Symbol                                           | Default    |
| ------------------------------------------------ | ---------- |
| `LOCAL_WORKSPACE_GREP_PATHSPEC_CHUNK_SIZE`       | 256        |
| `LOCAL_WORKSPACE_TREE_WALK_CONCURRENCY`          | 32         |
| `PR_REPOSITORY_VIEW_RELEASE_GRACE_MS`            | 60000      |
| `LOCAL_WORKSPACE_CLONE_TIMEOUT_MS`               | 60000      |
| `LOCAL_WORKSPACE_FETCH_TIMEOUT_MS`               | 60000      |
| `LOCAL_WORKSPACE_SEARCH_MAX_FILES`               | 500        |
| `LOCAL_WORKSPACE_MAX_FILE_BYTES`                 | 1000000    |
| `LOCAL_WORKSPACE_SEARCH_MAX_TOTAL_BYTES`         | 50000000   |
| `LOCAL_WORKSPACE_MAX_DIFF_BYTES`                 | 5000000    |
| `LOCAL_WORKSPACE_READ_RESPONSE_BYTES`            | 128000     |
| `LOCAL_WORKSPACE_READ_MAX_LINE_CHARACTERS`       | 2000       |
| `LOCAL_WORKSPACE_DIFF_RESPONSE_BYTES`            | 256000     |
| `LOCAL_WORKSPACE_MIN_FREE_SPACE_BYTES`           | 500000000  |
| `LOCAL_WORKSPACE_MAX_FETCH_BYTES`                | 2147483648 |
| `LOCAL_WORKSPACE_FULL_CLONE_MAX_REPO_KB`         | 1000000    |
| `LOCAL_WORKSPACE_STALE_CLEANUP_AGE_SECONDS`      | 3600       |
| `LOCAL_WORKSPACE_SYMBOL_INDEX_BUILD_TIMEOUT_MS`  | 5000       |
| `LOCAL_WORKSPACE_SYMBOL_INDEX_MAX_SYMBOLS`       | 50000      |
| `LOCAL_WORKSPACE_SYMBOL_INDEX_MAX_RESULTS`       | 50         |
| `LOCAL_WORKSPACE_SYMBOL_INDEX_READ_CONCURRENCY`  | 16         |
| `LOCAL_WORKSPACE_READ_MAX_PATH_SUGGESTIONS`      | 5          |
| `LOCAL_WORKSPACE_PATH_SUGGESTION_MIN_SIMILARITY` | 0.6        |

### Code index (optional FTS hints)

| Symbol                           | Value / role |
| -------------------------------- | ------------ |
| `CODE_INDEX_MODES`               | `off`, `fts` |
| `CODE_INDEX_CHUNKER_VERSION`     | `1`          |
| `CODE_INDEX_MAX_CHUNKS_PER_REPO` | 100000       |
| `CODE_INDEX_MAX_RESULTS`         | 20           |
| `CODE_INDEX_PREVIEW_MAX_CHARS`   | 500          |
| `CODE_INDEX_BUILD_CONCURRENCY`   | 1            |

### Postgres pool

| Symbol                                    | Default | Role                                   |
| ----------------------------------------- | ------- | -------------------------------------- |
| `POSTGRES_POOL_MAX`                       | 10      | app pool size                          |
| `PG_BOSS_POOL_MAX_WEB`                    | 4       | pg-boss pool size for `ROLE=web`       |
| `PG_BOSS_POOL_MAX_WORKER`                 | 8       | pg-boss pool size for `ROLE=worker`    |
| `POSTGRES_IDLE_TIMEOUT_MS`                | 30000   | idle client reap                       |
| `POSTGRES_CONNECTION_TIMEOUT_MS`          | 5000    | connect timeout                        |
| `POSTGRES_STATEMENT_TIMEOUT_MS`           | 60000   | per-statement timeout                  |
| `POSTGRES_KEEPALIVE_INITIAL_DELAY_MS`     | 10000   | TCP keepalive initial delay            |
| `POSTGRES_LOCK_TIMEOUT_MS`                | 10000   | per-statement lock acquisition timeout |
| `POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS` | 60000   | idle-in-transaction session timeout    |

### Other

| Symbol                                              | Role                                                          |
| --------------------------------------------------- | ------------------------------------------------------------- |
| `CONTEXT7_BASE_URL`                                 | Context7 API                                                  |
| `MAX_LOG_MESSAGE_LEN`                               | 2000                                                          |
| `MAX_LOG_REDACTION_SCAN_LEN`                        | 8000                                                          |
| `SLASH_HELP_BODY`                                   | `/help` text                                                  |
| `SLASH_CANCEL_NONE_BODY` / `SLASH_CANCEL_DONE_BODY` | `/cancel` ack replies when no review is active / after cancel |
| `SLASH_REVIEW_ALREADY_IN_PROGRESS_BODY`             | `/review` ack reply when a run is already active              |
| `SLASH_VERIFY_ALREADY_IN_PROGRESS_BODY`             | `/verify` ack reply when a run is already active              |
| `SLASH_REVIEW_FORCE_RESTARTED_BODY`                 | `/review force` ack reply after a force restart               |
| `MIGRATIONS_DIR_NAME`                               | `migrations`                                                  |
| `MIGRATION_ADVISORY_LOCK_KEY`                       | runMigrations cross-process lock                              |
| `GITHUB_WEBHOOK_RESPONSE_MARGIN_MS`                 | 2000ms margin before GitHub's webhook timeout                 |
| `WEBHOOK_MAX_BODY_BYTES`                            | 25000000 (GitHub payload cap)                                 |
| `WEBHOOK_TIMEOUT_MS`                                | 10000 (intake 503 budget)                                     |
| `CONTEXT7_RESPONSE_BYTES`                           | 64000                                                         |
| `CONTEXT7_LIBRARY_NAME_MAX_CHARS`                   | 128                                                           |
| `CONTEXT7_LIBRARY_ID_MAX_CHARS`                     | 256                                                           |
| `CONTEXT7_QUERY_MAX_CHARS`                          | 256                                                           |
| `CONTEXT7_TOPIC_MAX_CHARS`                          | 256                                                           |
| `LOG_MAX_WIDE_EVENTS`                               | 128                                                           |
| `HEALTH_DB_PING_TIMEOUT_MS`                         | 2000 (`/ready` Postgres ping budget)                          |

Prompt prose (investigator contracts) remains in `src/review/prompts/`, `src/agent/prompts/`, `src/agent/ask/`, `src/agent/description/`, `src/agent/triage/`, and `src/agent/verification/`.

Private specialist orchestration constants (not exported from `src/settings/`): `INITIAL_JITTER_MAX_MS` (`3000`) and `RETRY_BACKOFF_BASE_MS` (`500`) live in `src/review/orchestrator/specialistRun.ts`.
