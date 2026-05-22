# Configuration catalog

Single place to find tunables for **pr-agent**. Code defaults live in [`src/settings/`](../src/settings/); env vars are loaded in [`src/config.ts`](../src/config.ts).

Maintenance rules: [AGENTS.md](../AGENTS.md).

## How to change something

| Kind | Where to edit |
|------|----------------|
| **env** | `.env` / deployment env → keys below; defaults in `src/settings/defaults.ts` |
| **code** | `src/settings/constants.ts` |
| **external** | Provider env (pi-ai); documented only here |

Import convention: `import { … } from "../settings/index.js"` for constants; `Config` from `config.ts` at runtime.

---

## Environment (`loadConfig`)

| Name | Env var | Default | Notes |
|------|---------|---------|-------|
| HTTP port | `PORT` | `3000` (7224 in Compose) | |
| Process role | `ROLE` | `web` | `web` or `worker` |
| GitHub App ID | `GITHUB_APP_ID` | — | required |
| App private key | `GITHUB_APP_PRIVATE_KEY` | — | required PEM |
| Webhook HMAC secret | `WEBHOOK_SECRET` | — | required |
| Postgres URL | `DATABASE_URL` | — | required |
| LLM provider | `PI_PROVIDER` | `openai` | pi-ai registry id |
| LLM model | `PI_MODEL` | `gpt-4o-mini` | |
| Review tool rounds | `MAX_TOOL_ROUNDS` | `24` | per review run |
| Publish recovery attempts | `MAX_REVIEW_PUBLISH_ATTEMPTS` | `3` | when submitReview never succeeds |
| Publish execution budget | `MAX_REVIEW_PUBLISH_CALLS` | `2` | valid submitReview publishes per run |
| Review worker concurrency | `REVIEW_CONCURRENCY` | `2` | pg-boss review queue workers |
| Ask worker concurrency | `ASK_CONCURRENCY` | `1` | pg-boss ask queue workers |
| Ack worker concurrency | `ACK_CONCURRENCY` | `2` | reactions + progress stub |
| Installation group cap | `INSTALLATION_GROUP_CONCURRENCY` | `2` | pg-boss group policy |
| Queue retry limit | `QUEUE_RETRY_LIMIT` | `3` | pg-boss job retries |
| Queue retry delay | `QUEUE_RETRY_DELAY_SECONDS` | `30` | |
| Queue retry delay max | `QUEUE_RETRY_DELAY_MAX_SECONDS` | `300` | |
| Job expire | `QUEUE_EXPIRE_IN_SECONDS` | `3600` | |
| Job heartbeat | `QUEUE_HEARTBEAT_SECONDS` | `60` | min 10 |
| Job retention | `QUEUE_RETENTION_SECONDS` | `1209600` | |
| Job delete after | `QUEUE_DELETE_AFTER_SECONDS` | `604800` | |
| Ask tool rounds | `MAX_ASK_TOOL_ROUNDS` | `12` | |
| Ask finalize rounds | `MAX_ASK_FINALIZE_ROUNDS` | `2` | |
| Webhook time budget | `WEBHOOK_TIMEOUT_MS` | `10000` | log warning only |
| Context7 API key | `CONTEXT7_API_KEY` | empty | optional |
| Max review findings | `MAX_REVIEW_FINDINGS` | `8` | Zod schema + publish cap |
| Label effort | `ENABLE_REVIEW_LABELS_EFFORT` | `true` | |
| Label security | `ENABLE_REVIEW_LABELS_SECURITY` | `false` | |
| Max PR files listed | `MAX_PR_FILES_LISTED` | `300` | listPullRequestFiles |
| Max PR patch bytes | `MAX_PR_FILES_PATCH_BYTES` | `500000` | |
| Log level | `LOG_LEVEL` | `info` | |
| Max wide sub-events | `LOG_MAX_WIDE_EVENTS` | `128` | |
| Pretty logs | `LOG_PRETTY` | dev `true`, prod `false` | |

### External (pi-ai)

Not loaded by `loadConfig()`. Set the secret(s) for your `PI_PROVIDER`.

| Env var | Purpose |
|---------|---------|
| `OPENAI_API_KEY` | OpenAI provider |
| `ANTHROPIC_API_KEY` | Anthropic provider |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google provider |

---

## Retry model split (document only)

| Mechanism | Default | Where |
|-----------|---------|--------|
| `agent_work_items.max_attempts` | `3` | SQL migration `001_agent_work.sql` |
| pg-boss `QUEUE_RETRY_LIMIT` | `3` | `src/agentWork/boss.ts` |

These are related but not wired together on INSERT today.

---

## Code constants (`src/settings/constants.ts`)

### Agent work (queues)

| Symbol | Value / role |
|--------|----------------|
| `ACK_QUEUE` | `agent-work-ack` |
| `REVIEW_QUEUE` | `agent-work-review` |
| `ASK_QUEUE` | `agent-work-ask` |
| `*_DEAD_LETTER_QUEUE` | DLQ names |
| `DEFERRED_HEAD_SHA` | worker resolves head SHA |
| `AUTOMATED_PR_ACTIONS` | opened, synchronize, reopened |
| `AUTOMATED_REVIEW_LENS` | `review` |
| `MAX_STORED_COMMENT_TEXT_LEN` | 16384 |

### Review output

| Symbol | Role |
|--------|------|
| `REVIEW_SUMMARY_SENTINEL` | PR conversation summary marker |
| `SECURITY_REVIEW_SUMMARY_SENTINEL` | Security summary marker |
| `REVIEW_POINTER_BODY` / `SECURITY_REVIEW_POINTER_BODY` | Files-tab pointer text |
| `REVIEW_POINTER_BODY_MAX_CHARS` | 60000 |
| `MAX_REVIEW_FOLLOW_UPS` | 5 |
| `REVIEW_EFFORT_MIN` / `REVIEW_EFFORT_MAX` | 1–5 |
| `REVIEW_SEVERITY_RANK` | P0–P3 ordering |
| Label prefixes | `LABEL_REVIEW_EFFORT_PREFIX`, `LABEL_SECURITY_CONCERN` |

### Review / ask agent loops

| Symbol | Default |
|--------|---------|
| `RATE_LIMIT_CIRCUIT_THRESHOLD` | 3 |
| `VALIDATION_REPAIR_ROUNDS` | 3 |
| `PUBLISH_RECOVERY_ROUNDS` | 4 |
| `ASK_RETRY_ROUNDS` | 4 |
| `PUBLISH_RECOVERY_PROMPTS` | recovery nudge strings |
| `REVIEW_*_CIRCUIT_OPEN_*` | rate-limit circuit messages |
| `ASK_*_CIRCUIT_OPEN_*` | ask circuit messages |
| `PUBLISH_BUDGET_EXHAUSTED_MESSAGE` | submitReview guard |

### Ask safety

| Symbol | Default |
|--------|---------|
| `MAX_ASK_QUESTION_CHARS` | 8192 |
| `ASK_META_REFUSAL` | meta-probe reply |
| `BOT_META_PATTERNS` | regex set |
| `BOT_SECRET_PATTERNS` | outbound redaction |
| `SENSITIVE_PATH_PATTERNS` | path gate |
| `ASK_TOOLS_WITH_OWNER_REPO` / `ASK_TOOLS_WITH_PULL_NUMBER` | tool scope sets |

### GitHub API

| Symbol | Default |
|--------|---------|
| `TOKEN_FRESHNESS_BUFFER_MS` | 60000 |
| `INSTALLATION_TOKEN_FALLBACK_TTL_MS` | 1h |
| `DEFAULT_COOLDOWN_SECONDS` | 60 |
| `PRIMARY_RATE_LIMIT_MAX_RETRIES` | 2 |
| `COMMENTS_PAGE_SIZE` | 100 |
| `GITHUB_REACTION_EYES` | eyes |

### Other

| Symbol | Role |
|--------|------|
| `CONTEXT7_BASE_URL` | Context7 API |
| `PUBLIC_OUTPUT_BANNED_PATTERNS` | sanitizer |
| `MAX_LOG_MESSAGE_LEN` | 2000 |
| `SLASH_HELP_BODY` | `/help` text |
| `MIGRATIONS_DIR_NAME` | `migrations` |

Prompt prose (investigator contracts) remains in `src/agent/reviewPromptBlocks.ts` and `src/agent/securityPrompt.ts`.
