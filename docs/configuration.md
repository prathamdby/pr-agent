# Configuration catalog

Single place to find tunables for **pr-agent**. Code defaults live in [`src/settings/`](../src/settings/); env vars are loaded in [`src/config.ts`](../src/config.ts).

Maintenance rules: [AGENTS.md](../AGENTS.md).

## How to change something

| Kind         | Where to edit                                                                |
| ------------ | ---------------------------------------------------------------------------- |
| **env**      | `.env` / deployment env → keys below; defaults in `src/settings/defaults.ts` |
| **code**     | `src/settings/constants.ts`                                                  |
| **external** | Provider env; loaded into config but never logged                            |

Import convention: `import { … } from "../settings/index.js"` for constants; `Config` from `config.ts` at runtime.

---

## Environment (`loadConfig`)

| Name                      | Env var                                     | Default                  | Notes                                              |
| ------------------------- | ------------------------------------------- | ------------------------ | -------------------------------------------------- |
| HTTP port                 | `PORT`                                      | `3000` (7224 in Compose) |                                                    |
| Process role              | `ROLE`                                      | `web`                    | `web` or `worker`                                  |
| GitHub App ID             | `GITHUB_APP_ID`                             | —                        | required                                           |
| App private key           | `GITHUB_APP_PRIVATE_KEY`                    | —                        | required PEM                                       |
| Webhook HMAC secret       | `WEBHOOK_SECRET`                            | —                        | required                                           |
| Postgres URL              | `DATABASE_URL`                              | —                        | required                                           |
| Agent provider            | `AGENT_PROVIDER`                            | `pi`                     | `pi` or `cursor` runner                            |
| LLM provider              | `PI_PROVIDER`                               | `openai`                 | Pi coding-agent model provider                     |
| LLM model                 | `PI_MODEL`                                  | `gpt-4o-mini`            | Cursor runner also uses this model id              |
| Cursor API key            | `CURSOR_API_KEY`                            | empty                    | required when `AGENT_PROVIDER=cursor`              |
| Provider prompt timeout   | `PROVIDER_PROMPT_TIMEOUT_MS`                | `300000`                 | abort + fail a run if one prompt turn exceeds this |
| Review tool rounds        | `MAX_TOOL_ROUNDS`                           | `24`                     | per review run                                     |
| Publish recovery attempts | `MAX_REVIEW_PUBLISH_ATTEMPTS`               | `3`                      | when submitReview never succeeds                   |
| Publish execution budget  | `MAX_REVIEW_PUBLISH_CALLS`                  | `2`                      | valid submitReview publishes per run               |
| Review worker concurrency | `REVIEW_CONCURRENCY`                        | `2`                      | pg-boss review queue workers                       |
| Ask worker concurrency    | `ASK_CONCURRENCY`                           | `1`                      | pg-boss ask queue workers                          |
| Description concurrency   | `DESCRIPTION_CONCURRENCY`                   | `1`                      | pg-boss description queue workers                  |
| Description tool rounds   | `MAX_TOOL_ROUNDS_DESCRIBE`                  | `16`                     | agent investigation cap for `/describe`            |
| Description AI title      | `DESCRIPTION_GENERATE_TITLE`                | `false`                  | when false, keep existing PR title on publish      |
| Ack worker concurrency    | `ACK_CONCURRENCY`                           | `2`                      | reactions + progress stub                          |
| Installation group cap    | `INSTALLATION_GROUP_CONCURRENCY`            | `2`                      | pg-boss group policy                               |
| Queue retry limit         | `QUEUE_RETRY_LIMIT`                         | `3`                      | pg-boss job retries                                |
| Queue retry delay         | `QUEUE_RETRY_DELAY_SECONDS`                 | `30`                     |                                                    |
| Queue retry delay max     | `QUEUE_RETRY_DELAY_MAX_SECONDS`             | `300`                    |                                                    |
| Job expire                | `QUEUE_EXPIRE_IN_SECONDS`                   | `3600`                   |                                                    |
| Job heartbeat             | `QUEUE_HEARTBEAT_SECONDS`                   | `60`                     | min 10                                             |
| Job retention             | `QUEUE_RETENTION_SECONDS`                   | `1209600`                |                                                    |
| Job delete after          | `QUEUE_DELETE_AFTER_SECONDS`                | `604800`                 |                                                    |
| Shutdown drain budget     | `SHUTDOWN_DRAIN_TIMEOUT_SECONDS`            | `25`                     | graceful pg-boss stop wait (s) on SIGTERM/SIGINT   |
| Webhook event retention   | `WEBHOOK_EVENTS_RETENTION_SECONDS`          | `2592000`                | delete webhook_events older than this (30d)        |
| Agent work retention      | `AGENT_WORK_RETENTION_SECONDS`              | `2592000`                | delete terminal agent_work_items older than this   |
| Retention schedule        | `RETENTION_CRON`                            | `17 3 * * *`             | cron for the worker cleanup sweep                  |
| Retention enabled         | `RETENTION_ENABLED`                         | `true`                   | toggle the scheduled cleanup sweep                 |
| Ask tool rounds           | `MAX_ASK_TOOL_ROUNDS`                       | `12`                     |                                                    |
| Ask finalize rounds       | `MAX_ASK_FINALIZE_ROUNDS`                   | `2`                      |                                                    |
| Webhook time budget       | `WEBHOOK_TIMEOUT_MS`                        | `10000`                  | log warning only                                   |
| Context7 API key          | `CONTEXT7_API_KEY`                          | empty                    | optional                                           |
| Label effort              | `ENABLE_REVIEW_LABELS_EFFORT`               | `true`                   |                                                    |
| Label security            | `ENABLE_REVIEW_LABELS_SECURITY`             | `false`                  |                                                    |
| Max PR files listed       | `MAX_PR_FILES_LISTED`                       | `300`                    | listPullRequestFiles                               |
| Max PR patch bytes        | `MAX_PR_FILES_PATCH_BYTES`                  | `500000`                 |                                                    |
| Review anchor menu inject | `REVIEW_INJECT_ANCHOR_MENU`                 | `true`                   | inject commentable line ranges before submitReview |
| Require diff cache submit | `REVIEW_REQUIRE_DIFF_CACHE_BEFORE_SUBMIT`   | `true`                   | block submitReview when diff index empty           |
| Anchor menu max files     | `REVIEW_ANCHOR_MENU_MAX_FILES`              | `40`                     | cap files in anchor menu block                     |
| Anchor menu max ranges    | `REVIEW_ANCHOR_MENU_MAX_RANGES_PER_FILE`    | `20`                     | cap ranges per file in anchor menu                 |
| Workspace clone timeout   | `LOCAL_WORKSPACE_CLONE_TIMEOUT_MS`          | `60000`                  | git clone/setup budget                             |
| Workspace fetch timeout   | `LOCAL_WORKSPACE_FETCH_TIMEOUT_MS`          | `60000`                  | git fetch/diff budget                              |
| Workspace file cap        | `LOCAL_WORKSPACE_MAX_MATERIALIZED_FILES`    | `500`                    | max files exposed to agent-visible tree            |
| Workspace single-file cap | `LOCAL_WORKSPACE_MAX_FILE_BYTES`            | `1000000`                | max file bytes readable by local tools             |
| Workspace total cap       | `LOCAL_WORKSPACE_MAX_TOTAL_BYTES`           | `50000000`               | max materialized bytes                             |
| Workspace diff cap        | `LOCAL_WORKSPACE_MAX_DIFF_BYTES`            | `5000000`                | max local diff bytes returned to tools             |
| Workspace free space min  | `LOCAL_WORKSPACE_MIN_FREE_SPACE_BYTES`      | `500000000`              | fail setup below this free-space threshold         |
| Workspace stale cleanup   | `LOCAL_WORKSPACE_STALE_CLEANUP_AGE_SECONDS` | `86400`                  | startup cleanup age for leaked temp dirs           |
| Workspace blame deepen    | `LOCAL_WORKSPACE_MAX_BLAME_DEEPEN_COMMITS`  | `1000`                   | best-effort blame history deepen cap               |
| Log level                 | `LOG_LEVEL`                                 | `info`                   |                                                    |
| Max wide sub-events       | `LOG_MAX_WIDE_EVENTS`                       | `128`                    |                                                    |
| Pretty logs               | `LOG_PRETTY`                                | dev `true`, prod `false` |                                                    |

### External model provider secrets

Loaded by `loadConfig()` into a redaction-safe map and never logged. Set the secret(s) for your `PI_PROVIDER`.

| Env var                        | Purpose            |
| ------------------------------ | ------------------ |
| `OPENAI_API_KEY`               | OpenAI provider    |
| `ANTHROPIC_API_KEY`            | Anthropic provider |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google provider    |

---

## Retry model split (document only)

| Mechanism                       | Default | Where                              |
| ------------------------------- | ------- | ---------------------------------- |
| `agent_work_items.max_attempts` | `3`     | SQL migration `001_agent_work.sql` |
| pg-boss `QUEUE_RETRY_LIMIT`     | `3`     | `src/agentWork/boss.ts`            |

These are related but not wired together on INSERT today.

---

## Code constants (`src/settings/constants.ts`)

### Agent work (queues)

| Symbol                             | Value / role                        |
| ---------------------------------- | ----------------------------------- |
| `ACK_QUEUE`                        | `agent-work-ack`                    |
| `REVIEW_QUEUE`                     | `agent-work-review`                 |
| `ASK_QUEUE`                        | `agent-work-ask`                    |
| `*_DEAD_LETTER_QUEUE`              | DLQ names                           |
| `DEFERRED_HEAD_SHA`                | worker resolves head SHA            |
| `AUTOMATED_PR_ACTIONS`             | opened, synchronize, reopened       |
| `AUTOMATED_DESCRIPTION_PR_ACTIONS` | opened only (use `/describe` after) |
| `AUTOMATED_REVIEW_LENS`            | `review`                            |
| `MAX_STORED_COMMENT_TEXT_LEN`      | 16384                               |

### Review output

| Symbol                                                                                 | Role                                                   |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `REVIEW_SUMMARY_SENTINEL`                                                              | PR conversation summary marker                         |
| `SECURITY_REVIEW_SUMMARY_SENTINEL`                                                     | Security summary marker                                |
| `QUALITY_REVIEW_SUMMARY_SENTINEL`                                                      | Code-quality summary marker                            |
| `REVIEW_POINTER_BODY` / `SECURITY_REVIEW_POINTER_BODY` / `QUALITY_REVIEW_POINTER_BODY` | Files-tab pointer text (repeat no-bugs fallback)       |
| `REVIEW_POINTER_NOTE_LEAD`                                                             | First-publish pointer NOTE body                        |
| `REVIEW_POINTER_BODY_MAX_CHARS`                                                        | 60000                                                  |
| `REVIEW_EFFORT_WORDS`                                                                  | Light → Heavy labels for effort row                    |
| `REVIEW_OVERVIEW_ALERT` / `REVIEW_FAILURE_ALERT`                                       | GitHub alert types (`NOTE`, `CAUTION`)                 |
| `REVIEW_PROGRESS_NOTE`                                                                 | In-progress NOTE body                                  |
| `REVIEW_PROGRESS_SOURCE_AUTO` / `REVIEW_PROGRESS_SOURCE_SLASH`                         | Progress table source labels                           |
| `LIGHTWEIGHT_REVIEW_COMPLETION_*`                                                      | Docs-only auto-review skip copy                        |
| `REVIEW_SIZE_TIER_*`                                                                   | Advisory small/medium/large tier thresholds            |
| `REVIEW_RISK_PATH_PATTERNS`                                                            | Path categories for trusted review context             |
| `REVIEW_FINDING_FOOTNOTE_INLINE` / `REVIEW_FINDING_FOOTNOTE_SUMMARY`                   | Finding row footnotes                                  |
| `REVIEW_FINDINGS_NONE`                                                                 | Empty findings table cell                              |
| `REVIEW_SECURITY_DEFAULT`                                                              | Default security row when null                         |
| `AGENT_FIX_PROMPT_ACCORDION_SUMMARY`                                                   | Pointer accordion title                                |
| `MAX_REVIEW_FOLLOW_UPS`                                                                | 5                                                      |
| `REVIEW_FINDING_TITLE_MAX_CHARS`                                                       | 80                                                     |
| `REVIEW_FINDING_DETAIL_MAX_CHARS`                                                      | 4000                                                   |
| `REVIEW_FINDING_FIX_PROMPT_MAX_CHARS`                                                  | 2000                                                   |
| `REVIEW_OVERVIEW_MAX_CHARS`                                                            | 8000                                                   |
| `REVIEW_OVERVIEW_COMPACT_MAX_CHARS`                                                    | 500                                                    |
| `REVIEW_SECURITY_CONCERNS_MAX_CHARS`                                                   | 4000                                                   |
| `REVIEW_FOLLOW_UP_MAX_CHARS`                                                           | 2000                                                   |
| `REVIEW_SUMMARY_BODY_MAX_CHARS`                                                        | 60000                                                  |
| `REVIEW_SUMMARY_COMPACTION_NOTE`                                                       | Public note when summary is compacted                  |
| `REVIEW_SUMMARY_FINDINGS_OMITTED_SUFFIX`                                               | Public note when finding rows are omitted              |
| `MAX_REVIEW_PAYLOAD_FINDINGS`                                                          | 128                                                    |
| `MAX_INLINE_REVIEW_COMMENTS`                                                           | 50                                                     |
| `REVIEW_EFFORT_MIN` / `REVIEW_EFFORT_MAX`                                              | 1–5                                                    |
| `REVIEW_SEVERITY_RANK`                                                                 | P0–P3 ordering                                         |
| Label prefixes                                                                         | `LABEL_REVIEW_EFFORT_PREFIX`, `LABEL_SECURITY_CONCERN` |

### Review / ask agent loops

| Symbol                               | Default                                |
| ------------------------------------ | -------------------------------------- |
| `VALIDATION_REPAIR_ROUNDS`           | 3                                      |
| `PUBLISH_RECOVERY_ROUNDS`            | 4                                      |
| `PUBLISH_RECOVERY_PROMPTS`           | recovery nudge strings                 |
| `REVIEW_*_CIRCUIT_OPEN_*`            | rate-limit circuit messages            |
| `ASK_*_CIRCUIT_OPEN_*`               | ask circuit messages                   |
| `PUBLISH_BUDGET_EXHAUSTED_MESSAGE`   | submitReview guard                     |
| `REVIEW_DIFF_CACHE_REQUIRED_MESSAGE` | submitReview diff-cache guard          |
| `REVIEW_ANCHOR_MENU_BLOCK_LABEL`     | untrusted anchor menu block label      |
| `ReviewValidationFailureKind`        | validation failure metric categories   |
| `ReviewPhase`                        | review harness phase metric categories |

### Ask safety

| Symbol                                                     | Default                                   |
| ---------------------------------------------------------- | ----------------------------------------- |
| `MAX_ASK_QUESTION_CHARS`                                   | 8192                                      |
| `ASK_META_REFUSAL`                                         | meta-probe reply                          |
| `BOT_META_PATTERNS`                                        | regex set                                 |
| `BOT_SECRET_PATTERNS`                                      | outbound redaction (ask + review publish) |
| `SENSITIVE_PATH_PATTERNS`                                  | path gate                                 |
| `ASK_TOOLS_WITH_OWNER_REPO` / `ASK_TOOLS_WITH_PULL_NUMBER` | tool scope sets                           |

### GitHub API

| Symbol                               | Default |
| ------------------------------------ | ------- |
| `TOKEN_FRESHNESS_BUFFER_MS`          | 60000   |
| `INSTALLATION_TOKEN_FALLBACK_TTL_MS` | 1h      |
| `DEFAULT_COOLDOWN_SECONDS`           | 60      |
| `PRIMARY_RATE_LIMIT_MAX_RETRIES`     | 2       |
| `SECONDARY_RATE_LIMIT_MAX_RETRIES`   | 3       |
| `COMMENTS_PAGE_SIZE`                 | 100     |
| `COMMENT_PAGINATION_MAX_PAGES`       | 20      |
| `GITHUB_REACTION_EYES`               | eyes    |

### Cursor SDK bridge

| Symbol                               | Default   |
| ------------------------------------ | --------- |
| `CURSOR_MCP_BIND_HOST`               | 127.0.0.1 |
| `CURSOR_MCP_TOKEN_BYTES`             | 32        |
| `CURSOR_MCP_SERVER_START_TIMEOUT_MS` | 5000      |
| `CURSOR_MAX_PORT_RETRIES`            | 5         |
| `CURSOR_MCP_SERVER_NAME`             | pr-agent  |

### Other

| Symbol                        | Role                                 |
| ----------------------------- | ------------------------------------ |
| `CONTEXT7_BASE_URL`           | Context7 API                         |
| `MAX_LOG_MESSAGE_LEN`         | 2000                                 |
| `SLASH_HELP_BODY`             | `/help` text                         |
| `MIGRATIONS_DIR_NAME`         | `migrations`                         |
| `MIGRATION_ADVISORY_LOCK_KEY` | runMigrations cross-process lock     |
| `HEALTH_DB_PING_TIMEOUT_MS`   | 2000 (`/ready` Postgres ping budget) |

Prompt prose (investigator contracts) remains in `src/review/reviewPromptBlocks.ts` and `src/agent/securityPrompt.ts`.
