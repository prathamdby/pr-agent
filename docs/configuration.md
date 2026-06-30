# Configuration catalog

Single place to find tunables for **pr-agent**. Code defaults live in [`src/settings/`](../src/settings/); env vars are loaded in [`src/config.ts`](../src/config.ts).

For behaviour, deployment, and developer scripts see [operations.md](operations.md). Maintenance rules: [AGENTS.md](../AGENTS.md).

## How to change something

| Kind         | Where to edit                                                                |
| ------------ | ---------------------------------------------------------------------------- |
| **env**      | `.env` / deployment env → keys below; defaults in `src/settings/defaults.ts` |
| **code**     | `src/settings/constants.ts`                                                  |
| **external** | Provider env; loaded into config but never logged                            |

Import convention: `import { … } from "../settings/index.js"` for constants; `Config` from `config.ts` at runtime.

---

## Environment (`loadConfig`)

| Name                        | Env var                                     | Default                     | Notes                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------- | ------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP port                   | `PORT`                                      | `3000` (7224 in Compose)    |                                                                                                                                                                                                                                                                                                                                                            |
| Process role                | `ROLE`                                      | `web`                       | `web` or `worker`                                                                                                                                                                                                                                                                                                                                          |
| GitHub App ID               | `GITHUB_APP_ID`                             | —                           | required                                                                                                                                                                                                                                                                                                                                                   |
| App private key             | `GITHUB_APP_PRIVATE_KEY`                    | —                           | required PEM                                                                                                                                                                                                                                                                                                                                               |
| Webhook HMAC secret         | `WEBHOOK_SECRET`                            | —                           | required                                                                                                                                                                                                                                                                                                                                                   |
| Postgres URL                | `DATABASE_URL`                              | —                           | required                                                                                                                                                                                                                                                                                                                                                   |
| Agent provider              | `AGENT_PROVIDER`                            | `pi`                        | `pi` or `cursor` runner                                                                                                                                                                                                                                                                                                                                    |
| LLM provider                | `PI_PROVIDER`                               | `openai`                    | Pi coding-agent model provider                                                                                                                                                                                                                                                                                                                             |
| LLM model                   | `PI_MODEL`                                  | `gpt-4o-mini`               | Cursor runner uses ids from `Cursor.models.list()` (validated at worker boot). Common ids: `composer-2.5`, `composer-2`, `gpt-5.5`, `gpt-5.4-high`, `claude-opus-4-7`, `claude-opus-4-8`, `claude-4.6-sonnet-high-thinking`, `gpt-5.3-codex-high`, `gemini-3.1-pro`, `auto`. Append `-fast` when the SDK exposes a `fast` parameter (e.g. `gpt-5.5-fast`). |
| Cursor API key              | `CURSOR_API_KEY`                            | empty                       | required when `AGENT_PROVIDER=cursor`                                                                                                                                                                                                                                                                                                                      |
| Provider prompt timeout     | `PROVIDER_PROMPT_TIMEOUT_MS`                | `300000`                    | inactivity cap: abort if no provider activity this long                                                                                                                                                                                                                                                                                                    |
| Review tool rounds          | `MAX_TOOL_ROUNDS`                           | `24`                        | per review run                                                                                                                                                                                                                                                                                                                                             |
| Publish recovery attempts   | `MAX_REVIEW_PUBLISH_ATTEMPTS`               | `3`                         | when submitReview never succeeds                                                                                                                                                                                                                                                                                                                           |
| Publish execution budget    | `MAX_REVIEW_PUBLISH_CALLS`                  | `2`                         | valid submitReview publishes per run                                                                                                                                                                                                                                                                                                                       |
| Review min confidence       | `REVIEW_MIN_CONFIDENCE`                     | `1`                         | drop scored findings below this 1-5 threshold before publish; unscored findings are kept                                                                                                                                                                                                                                                                   |
| Review worker concurrency   | `REVIEW_CONCURRENCY`                        | `2`                         | pg-boss review queue workers                                                                                                                                                                                                                                                                                                                               |
| Ask worker concurrency      | `ASK_CONCURRENCY`                           | `1`                         | pg-boss ask queue workers                                                                                                                                                                                                                                                                                                                                  |
| Description concurrency     | `DESCRIPTION_CONCURRENCY`                   | `1`                         | pg-boss description queue workers                                                                                                                                                                                                                                                                                                                          |
| Triage concurrency          | `TRIAGE_CONCURRENCY`                        | `1`                         | pg-boss triage queue workers                                                                                                                                                                                                                                                                                                                               |
| Description tool rounds     | `MAX_TOOL_ROUNDS_DESCRIBE`                  | `16`                        | agent investigation cap for `/describe`                                                                                                                                                                                                                                                                                                                    |
| Triage tool rounds          | `MAX_TOOL_ROUNDS_TRIAGE`                    | `32`                        | agent investigation cap for `/triage`                                                                                                                                                                                                                                                                                                                      |
| Triage fix budget           | `MAX_TRIAGE_FIXES_PER_RUN`                  | `10`                        | max commitFix calls per `/triage` run; remaining findings should be skipped with a concrete reason                                                                                                                                                                                                                                                         |
| Description AI title        | `DESCRIPTION_GENERATE_TITLE`                | `false`                     | when false, keep existing PR title on publish                                                                                                                                                                                                                                                                                                              |
| Slash command allowlist     | `SLASH_ALLOWED_ASSOCIATIONS`                | `OWNER,MEMBER,COLLABORATOR` | comma-separated GitHub comment author associations allowed to run slash commands; valid values: `OWNER`, `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`, `NONE`, `MANNEQUIN`; set `*` to allow all                                                                                                                       |
| Ack worker concurrency      | `ACK_CONCURRENCY`                           | `2`                         | reactions + progress stub                                                                                                                                                                                                                                                                                                                                  |
| Installation group cap      | `INSTALLATION_GROUP_CONCURRENCY`            | `2`                         | pg-boss group policy                                                                                                                                                                                                                                                                                                                                       |
| Queue retry limit           | `QUEUE_RETRY_LIMIT`                         | `3`                         | pg-boss job retries                                                                                                                                                                                                                                                                                                                                        |
| Queue retry delay           | `QUEUE_RETRY_DELAY_SECONDS`                 | `30`                        |                                                                                                                                                                                                                                                                                                                                                            |
| Queue retry delay max       | `QUEUE_RETRY_DELAY_MAX_SECONDS`             | `300`                       |                                                                                                                                                                                                                                                                                                                                                            |
| Job expire                  | `QUEUE_EXPIRE_IN_SECONDS`                   | `3600`                      |                                                                                                                                                                                                                                                                                                                                                            |
| Job heartbeat               | `QUEUE_HEARTBEAT_SECONDS`                   | `60`                        | min 10                                                                                                                                                                                                                                                                                                                                                     |
| Queue polling interval      | `QUEUE_POLLING_INTERVAL_SECONDS`            | `0.5`                       | pg-boss worker poll interval in seconds; min 0.5                                                                                                                                                                                                                                                                                                           |
| Job retention               | `QUEUE_RETENTION_SECONDS`                   | `1209600`                   |                                                                                                                                                                                                                                                                                                                                                            |
| Job delete after            | `QUEUE_DELETE_AFTER_SECONDS`                | `604800`                    |                                                                                                                                                                                                                                                                                                                                                            |
| Shutdown drain budget       | `SHUTDOWN_DRAIN_TIMEOUT_SECONDS`            | `25`                        | graceful pg-boss stop wait (s) on SIGTERM/SIGINT                                                                                                                                                                                                                                                                                                           |
| Webhook event retention     | `WEBHOOK_EVENTS_RETENTION_SECONDS`          | `2592000`                   | delete webhook_events older than this (30d)                                                                                                                                                                                                                                                                                                                |
| Agent work retention        | `AGENT_WORK_RETENTION_SECONDS`              | `2592000`                   | delete terminal agent_work_items older than this                                                                                                                                                                                                                                                                                                           |
| Retention schedule          | `RETENTION_CRON`                            | `17 3 * * *`                | cron for the worker cleanup sweep                                                                                                                                                                                                                                                                                                                          |
| Retention enabled           | `RETENTION_ENABLED`                         | `true`                      | toggle the scheduled cleanup sweep                                                                                                                                                                                                                                                                                                                         |
| Ask tool rounds             | `MAX_ASK_TOOL_ROUNDS`                       | `12`                        |                                                                                                                                                                                                                                                                                                                                                            |
| Ask finalize rounds         | `MAX_ASK_FINALIZE_ROUNDS`                   | `2`                         |                                                                                                                                                                                                                                                                                                                                                            |
| Webhook body byte cap       | `WEBHOOK_MAX_BODY_BYTES`                    | `25000000`                  | rejects request bodies above this size before signature verification or JSON parsing                                                                                                                                                                                                                                                                       |
| Webhook response budget     | `WEBHOOK_TIMEOUT_MS`                        | `10000`                     | returns 503 when intake exceeds this budget minus the GitHub response margin                                                                                                                                                                                                                                                                               |
| Context7 API key            | `CONTEXT7_API_KEY`                          | empty                       | optional                                                                                                                                                                                                                                                                                                                                                   |
| Context7 response cap       | `CONTEXT7_RESPONSE_BYTES`                   | `64000`                     | max bytes returned to the model from Context7 tools                                                                                                                                                                                                                                                                                                        |
| Label effort                | `ENABLE_REVIEW_LABELS_EFFORT`               | `true`                      |                                                                                                                                                                                                                                                                                                                                                            |
| Label security              | `ENABLE_REVIEW_LABELS_SECURITY`             | `false`                     |                                                                                                                                                                                                                                                                                                                                                            |
| Thread replies              | `ENABLE_THREAD_REPLIES`                     | `false`                     | enqueue `/ask` when a maintainer replies in a bot inline review thread (no slash command)                                                                                                                                                                                                                                                                  |
| Review commit status        | `ENABLE_REVIEW_COMMIT_STATUS`               | `false`                     | post GitHub commit status `pr-agent/review` on the PR head after summary publish; `failure` when published findings include P0/P1, else `success`. Use this context in branch protection rules.                                                                                                                                                            |
| Description auto actions    | `DESCRIPTION_AUTO_ACTIONS`                  | `opened`                    | comma-separated `pull_request` actions that auto-run `/describe`; adding `synchronize` re-runs the description LLM on every push                                                                                                                                                                                                                           |
| Review auto actions         | `REVIEW_AUTO_ACTIONS`                       | `opened`                    | comma-separated `pull_request` actions that auto-run `/review`; default `opened` reviews once at PR start — add `synchronize` or `reopened` to re-review on every push/reopen. Manual `/review` always re-runs.                                                                                                                                            |
| Max PR files listed         | `MAX_PR_FILES_LISTED`                       | `300`                       | listPullRequestFiles; clamped to 3000, the GitHub API maximum                                                                                                                                                                                                                                                                                              |
| Max PR patch bytes          | `MAX_PR_FILES_PATCH_BYTES`                  | `500000`                    |                                                                                                                                                                                                                                                                                                                                                            |
| Review anchor menu inject   | `REVIEW_INJECT_ANCHOR_MENU`                 | `true`                      | inject commentable line ranges before submitReview                                                                                                                                                                                                                                                                                                         |
| Require diff cache submit   | `REVIEW_REQUIRE_DIFF_CACHE_BEFORE_SUBMIT`   | `true`                      | block submitReview when diff index empty                                                                                                                                                                                                                                                                                                                   |
| Anchor menu max files       | `REVIEW_ANCHOR_MENU_MAX_FILES`              | `40`                        | cap files in anchor menu block                                                                                                                                                                                                                                                                                                                             |
| Anchor menu max ranges      | `REVIEW_ANCHOR_MENU_MAX_RANGES_PER_FILE`    | `20`                        | cap ranges per file in anchor menu                                                                                                                                                                                                                                                                                                                         |
| Workspace clone timeout     | `LOCAL_WORKSPACE_CLONE_TIMEOUT_MS`          | `60000`                     | git clone/setup budget                                                                                                                                                                                                                                                                                                                                     |
| Workspace fetch timeout     | `LOCAL_WORKSPACE_FETCH_TIMEOUT_MS`          | `60000`                     | git fetch/diff budget                                                                                                                                                                                                                                                                                                                                      |
| Workspace search file cap   | `LOCAL_WORKSPACE_SEARCH_MAX_FILES`          | `500`                       | legacy JS search scan cap; `searchWorkspace` now uses git grep and reports matched file count                                                                                                                                                                                                                                                              |
| Workspace single-file cap   | `LOCAL_WORKSPACE_MAX_FILE_BYTES`            | `1000000`                   | max file bytes readable by local tools                                                                                                                                                                                                                                                                                                                     |
| Workspace search byte cap   | `LOCAL_WORKSPACE_SEARCH_MAX_TOTAL_BYTES`    | `50000000`                  | max git grep stdout bytes before `searchWorkspace` returns a truncated result                                                                                                                                                                                                                                                                              |
| Workspace diff cap          | `LOCAL_WORKSPACE_MAX_DIFF_BYTES`            | `5000000`                   | max local diff bytes fetched from git before tool output capping                                                                                                                                                                                                                                                                                           |
| Workspace read response cap | `LOCAL_WORKSPACE_READ_RESPONSE_BYTES`       | `128000`                    | max bytes returned to the model from `readWorkspaceFile`                                                                                                                                                                                                                                                                                                   |
| Workspace diff response cap | `LOCAL_WORKSPACE_DIFF_RESPONSE_BYTES`       | `256000`                    | max bytes returned to the model from `getWorkspaceDiff` and `getWorkspaceBlame`                                                                                                                                                                                                                                                                            |
| Workspace free space min    | `LOCAL_WORKSPACE_MIN_FREE_SPACE_BYTES`      | `500000000`                 | fail setup below this free-space threshold                                                                                                                                                                                                                                                                                                                 |
| Workspace fetch byte cap    | `LOCAL_WORKSPACE_MAX_FETCH_BYTES`           | `2147483648`                | fail after fetch when git object store exceeds this size (pre-checkout)                                                                                                                                                                                                                                                                                    |
| Full clone repo size cap    | `LOCAL_WORKSPACE_FULL_CLONE_MAX_REPO_KB`    | `1000000`                   | use sparse changed-file checkout above this repo size                                                                                                                                                                                                                                                                                                      |
| Workspace stale cleanup     | `LOCAL_WORKSPACE_STALE_CLEANUP_AGE_SECONDS` | `86400`                     | startup cleanup age for leaked temp dirs                                                                                                                                                                                                                                                                                                                   |
| Log level                   | `LOG_LEVEL`                                 | `info`                      |                                                                                                                                                                                                                                                                                                                                                            |
| Max wide sub-events         | `LOG_MAX_WIDE_EVENTS`                       | `128`                       |                                                                                                                                                                                                                                                                                                                                                            |
| Pretty logs                 | `LOG_PRETTY`                                | dev `true`, prod `false`    |                                                                                                                                                                                                                                                                                                                                                            |
| Redact logs                 | `LOG_REDACT`                                | `true`                      | scrub secret-shaped substrings from emitted logs                                                                                                                                                                                                                                                                                                           |

### External model provider secrets

Loaded by `loadConfig()` into a redaction-safe map and never logged. Set the secret(s) for your `PI_PROVIDER`.

| Env var                        | Purpose            |
| ------------------------------ | ------------------ |
| `OPENAI_API_KEY`               | OpenAI provider    |
| `ANTHROPIC_API_KEY`            | Anthropic provider |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google provider    |

---

Work item retries are controlled only by pg-boss (`QUEUE_RETRY_LIMIT`, `QUEUE_RETRY_DELAY`, `QUEUE_RETRY_BACKOFF`).

---

## Code constants (`src/settings/constants.ts`)

### Agent work (queues)

| Symbol                                     | Value / role                                                                                                                                                                |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ACK_QUEUE`                                | `agent-work-ack`                                                                                                                                                            |
| `REVIEW_QUEUE`                             | `agent-work-review`                                                                                                                                                         |
| `ASK_QUEUE`                                | `agent-work-ask`                                                                                                                                                            |
| `TRIAGE_QUEUE`                             | `agent-work-triage`                                                                                                                                                         |
| `RETENTION_QUEUE_POLLING_INTERVAL_SECONDS` | 60                                                                                                                                                                          |
| `*_DEAD_LETTER_QUEUE`                      | DLQ names                                                                                                                                                                   |
| `DEFERRED_HEAD_SHA`                        | worker resolves head SHA                                                                                                                                                    |
| `AUTOMATED_PR_ACTIONS`                     | opened, synchronize, reopened                                                                                                                                               |
| `DESCRIPTION_AUTO_ACTIONS` (env)           | `opened` — comma-separated `pull_request` actions that auto-run `/describe`; adding `synchronize` re-runs the description LLM on every push                                 |
| `REVIEW_AUTO_ACTIONS` (env)                | `opened` — comma-separated `pull_request` actions that auto-run `/review`; default reviews once at PR start; add `synchronize`/`reopened` to re-review on every push/reopen |
| `AUTOMATED_REVIEW_LENS`                    | `review`                                                                                                                                                                    |
| `ASK_PUBLISH_LENS`                         | `ask`                                                                                                                                                                       |
| `TRIAGE_PUBLISH_LENS`                      | `triage`                                                                                                                                                                    |
| `MAX_STORED_COMMENT_TEXT_LEN`              | 16384                                                                                                                                                                       |

### Review output

| Symbol                                                                                                               | Role                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REVIEW_SUMMARY_SENTINEL`                                                                                            | PR conversation summary marker                                                                                                                                              |
| `SECURITY_REVIEW_SUMMARY_SENTINEL`                                                                                   | Security summary marker                                                                                                                                                     |
| `QUALITY_REVIEW_SUMMARY_SENTINEL`                                                                                    | Code-quality summary marker                                                                                                                                                 |
| `TESTS_REVIEW_SUMMARY_SENTINEL`                                                                                      | Tests summary marker (`/review-tests` lens)                                                                                                                                 |
| `REVIEW_POINTER_BODY` / `SECURITY_REVIEW_POINTER_BODY` / `QUALITY_REVIEW_POINTER_BODY` / `TESTS_REVIEW_POINTER_BODY` | Files-tab pointer text (repeat no-bugs fallback)                                                                                                                            |
| `REVIEW_POINTER_NOTE_LEAD`                                                                                           | First-publish pointer NOTE body                                                                                                                                             |
| `REVIEW_POINTER_BODY_MAX_CHARS`                                                                                      | 60000                                                                                                                                                                       |
| `REVIEW_EFFORT_WORDS`                                                                                                | Light → Heavy labels for effort row                                                                                                                                         |
| `REVIEW_OVERVIEW_ALERT` / `REVIEW_FAILURE_ALERT`                                                                     | GitHub alert types (`NOTE`, `CAUTION`)                                                                                                                                      |
| `REVIEW_PROGRESS_NOTE`                                                                                               | In-progress NOTE body                                                                                                                                                       |
| `REVIEW_PROGRESS_SOURCE_AUTO` / `REVIEW_PROGRESS_SOURCE_SLASH`                                                       | Progress table source labels                                                                                                                                                |
| `LIGHTWEIGHT_REVIEW_COMPLETION_*`                                                                                    | Docs-only auto-review skip copy                                                                                                                                             |
| `REVIEW_SIZE_TIER_*`                                                                                                 | Advisory small/medium/large tier thresholds                                                                                                                                 |
| `REVIEW_RISK_PATH_PATTERNS`                                                                                          | Path categories for trusted review context                                                                                                                                  |
| `REVIEW_FINDING_FOOTNOTE_INLINE` / `REVIEW_FINDING_FOOTNOTE_SUMMARY`                                                 | Finding row footnotes                                                                                                                                                       |
| `REVIEW_FINDINGS_NONE`                                                                                               | Empty findings table cell                                                                                                                                                   |
| `REVIEW_SECURITY_DEFAULT`                                                                                            | Default security row when null                                                                                                                                              |
| `AGENT_FIX_PROMPT_ACCORDION_SUMMARY`                                                                                 | Pointer accordion title                                                                                                                                                     |
| `MAX_REVIEW_FOLLOW_UPS`                                                                                              | 5                                                                                                                                                                           |
| `REVIEW_FINDING_TITLE_MAX_CHARS`                                                                                     | 80                                                                                                                                                                          |
| `REVIEW_FINDING_DETAIL_MAX_CHARS`                                                                                    | 4000                                                                                                                                                                        |
| `REVIEW_FINDING_FIX_PROMPT_MAX_CHARS`                                                                                | 2000                                                                                                                                                                        |
| `REVIEW_FINDING_SUGGESTED_CODE_MAX_CHARS`                                                                            | 2000                                                                                                                                                                        |
| `REVIEW_OVERVIEW_MAX_CHARS`                                                                                          | 8000                                                                                                                                                                        |
| `REVIEW_OVERVIEW_COMPACT_MAX_CHARS`                                                                                  | 500                                                                                                                                                                         |
| `REVIEW_SECURITY_CONCERNS_MAX_CHARS`                                                                                 | 4000                                                                                                                                                                        |
| `REVIEW_FOLLOW_UP_MAX_CHARS`                                                                                         | 2000                                                                                                                                                                        |
| `REVIEW_SUMMARY_BODY_MAX_CHARS`                                                                                      | 60000                                                                                                                                                                       |
| `REVIEW_SUMMARY_COMPACTION_NOTE`                                                                                     | Public note when summary is compacted                                                                                                                                       |
| `REVIEW_SUMMARY_FINDINGS_OMITTED_SUFFIX`                                                                             | Public note when finding rows are omitted                                                                                                                                   |
| `MAX_REVIEW_PAYLOAD_FINDINGS`                                                                                        | 128                                                                                                                                                                         |
| `MAX_INLINE_REVIEW_COMMENTS`                                                                                         | 50                                                                                                                                                                          |
| `REVIEW_EFFORT_MIN` / `REVIEW_EFFORT_MAX`                                                                            | 1–5                                                                                                                                                                         |
| `REVIEW_SEVERITY_RANK`                                                                                               | P0–P3 ordering                                                                                                                                                              |
| Label prefixes                                                                                                       | `LABEL_REVIEW_EFFORT_PREFIX`, `LABEL_SECURITY_EFFORT_PREFIX`, `LABEL_QUALITY_EFFORT_PREFIX`, `LABEL_TESTS_EFFORT_PREFIX`, `LABEL_SECURITY_CONCERN`, `LABEL_CATEGORY_PREFIX` |
| `REVIEW_WALKTHROUGH_MAX_FILES`                                                                                       | 40                                                                                                                                                                          |
| `REVIEW_FINDING_FINGERPRINT_LINE_BUCKET_SIZE`                                                                        | 50                                                                                                                                                                          |
| `REPO_POLICY_FILENAME`                                                                                               | `.pr-agent.yml` at checkout root                                                                                                                                            |
| `MAX_REPO_POLICY_BYTES`                                                                                              | 32768                                                                                                                                                                       |
| `MAX_REPO_POLICY_TONE_CHARS`                                                                                         | 500                                                                                                                                                                         |
| `MAX_REPO_POLICY_PATH_PATTERN_CHARS`                                                                                 | 200                                                                                                                                                                         |
| `MAX_REPO_POLICY_INSTRUCTION_CHARS`                                                                                  | 1000                                                                                                                                                                        |
| `MAX_REPO_POLICY_PATH_INSTRUCTIONS`                                                                                  | 20                                                                                                                                                                          |

#### Per-repo policy file (`.pr-agent.yml`)

Schema version 1. Read from the PR head checkout at review preflight. Invalid or oversized files are ignored (warn logged); review proceeds without policy.

| Field              | Type    | Cap                                  | Role                                                                              |
| ------------------ | ------- | ------------------------------------ | --------------------------------------------------------------------------------- |
| `version`          | `1`     | required                             | Schema gate                                                                       |
| `tone`             | string  | 500 chars                            | Review tone hint in trusted context                                               |
| `severityFloor`    | int 0–3 | optional                             | Publish gate: drop findings below P{floor} (0=P0 … 3=P3)                          |
| `pathInstructions` | array   | ≤20 entries                          | Glob `path` (200 chars) + `instructions` (1000 chars); matched changed files only |
| `lensOverrides`    | map     | per-lens `instructions` (1000 chars) | Extra prompt for `review`, `review-security`, `review-quality`, `review-tests`    |

Rules augment prompts and publish gates only. They never replace the structured `submitReview` path or change output schemas.

Example:

```yaml
version: 1
tone: Be direct; skip style nits on generated code.
severityFloor: 2
pathInstructions:
  - path: "src/auth/**"
    instructions: Treat missing session checks as P1 minimum.
lensOverrides:
  review-security:
    instructions: Flag any new outbound HTTP without timeout.
```

### Review / ask agent loops

| Symbol                               | Default                                |
| ------------------------------------ | -------------------------------------- |
| `VALIDATION_REPAIR_ROUNDS`           | 3                                      |
| `PUBLISH_RECOVERY_ROUNDS`            | 4                                      |
| `PUBLISH_RECOVERY_PROMPTS`           | recovery nudge strings                 |
| `PUBLISH_BUDGET_EXHAUSTED_MESSAGE`   | submitReview guard                     |
| `REVIEW_DIFF_CACHE_REQUIRED_MESSAGE` | submitReview diff-cache guard          |
| `REVIEW_ANCHOR_MENU_BLOCK_LABEL`     | untrusted anchor menu block label      |
| `ReviewValidationFailureKind`        | validation failure metric categories   |
| `ReviewPhase`                        | review harness phase metric categories |

### Triage

| Symbol                               | Default / role                                      |
| ------------------------------------ | --------------------------------------------------- |
| `TRIAGE_SUMMARY_SENTINEL`            | `## PR Agent Triage`                                |
| `TRIAGE_ALREADY_IN_PROGRESS`         | duplicate `/triage` ack text                        |
| `TRIAGE_FAILURE_MESSAGE`             | terminal failure PR comment                         |
| `TRIAGE_NO_PRIOR_FINDINGS`           | legacy empty inventory text (deprecated alias)      |
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
| `TRIAGE_COMMIT_MAX_FILES`            | 20                                                  |
| `TRIAGE_MAX_COMMIT_DIFF_LINES`       | 200                                                 |
| `TRIAGE_NEW_FILE_MAX_BYTES`          | 32768                                               |

### Ask safety

| Symbol                                                     | Default                                                                            |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `MAX_ASK_QUESTION_CHARS`                                   | 8192                                                                               |
| `ASK_META_REFUSAL`                                         | meta-probe reply                                                                   |
| `BOT_META_PATTERNS`                                        | regex set                                                                          |
| `BOT_SECRET_PATTERNS`                                      | outbound redaction for auth headers, provider keys, JWTs, and secret-shaped tokens |
| `SENSITIVE_PATH_PATTERNS`                                  | ask path gate for env files, key material, and credential stores                   |
| `ASK_TOOLS_WITH_OWNER_REPO` / `ASK_TOOLS_WITH_PULL_NUMBER` | tool scope sets                                                                    |

### GitHub API

| Symbol                                    | Default |
| ----------------------------------------- | ------- |
| `TOKEN_FRESHNESS_BUFFER_MS`               | 60000   |
| `INSTALLATION_TOKEN_FALLBACK_TTL_MS`      | 1h      |
| `DEFAULT_COOLDOWN_SECONDS`                | 60      |
| `PRIMARY_RATE_LIMIT_MAX_RETRIES`          | 2       |
| `SECONDARY_RATE_LIMIT_MAX_RETRIES`        | 3       |
| `GITHUB_PULL_REQUEST_FILES_API_MAX_FILES` | 3000    |
| `COMMENTS_PAGE_SIZE`                      | 100     |
| `COMMENT_PAGINATION_MAX_PAGES`            | 20      |
| `GITHUB_REACTION_EYES`                    | eyes    |

### Local PR workspace

| Symbol                                     | Default |
| ------------------------------------------ | ------- |
| `LOCAL_WORKSPACE_GREP_PATHSPEC_CHUNK_SIZE` | 256     |
| `LOCAL_WORKSPACE_TREE_WALK_CONCURRENCY`    | 32      |
| `PR_REPOSITORY_VIEW_RELEASE_GRACE_MS`      | 60000   |

### Cursor SDK bridge

| Symbol                               | Default   |
| ------------------------------------ | --------- |
| `CURSOR_DEFAULT_CONTEXT_WINDOW`      | 200000    |
| `CURSOR_DEFAULT_MAX_TOKENS`          | 16384     |
| `CURSOR_MCP_BIND_HOST`               | 127.0.0.1 |
| `CURSOR_MCP_TOKEN_BYTES`             | 32        |
| `CURSOR_MCP_SERVER_START_TIMEOUT_MS` | 5000      |
| `CURSOR_MAX_PORT_RETRIES`            | 5         |
| `CURSOR_MCP_SERVER_NAME`             | pr-agent  |

### Postgres pool

| Symbol                           | Default |
| -------------------------------- | ------- |
| `POSTGRES_POOL_MAX`              | 10      |
| `POSTGRES_IDLE_TIMEOUT_MS`       | 30000   |
| `POSTGRES_CONNECTION_TIMEOUT_MS` | 5000    |
| `POSTGRES_STATEMENT_TIMEOUT_MS`  | 60000   |

### Other

| Symbol                              | Role                                          |
| ----------------------------------- | --------------------------------------------- |
| `CONTEXT7_BASE_URL`                 | Context7 API                                  |
| `MAX_LOG_MESSAGE_LEN`               | 2000                                          |
| `MAX_LOG_REDACTION_SCAN_LEN`        | 8000                                          |
| `SLASH_HELP_BODY`                   | `/help` text                                  |
| `MIGRATIONS_DIR_NAME`               | `migrations`                                  |
| `MIGRATION_ADVISORY_LOCK_KEY`       | runMigrations cross-process lock              |
| `GITHUB_WEBHOOK_RESPONSE_MARGIN_MS` | 2000ms margin before GitHub's webhook timeout |
| `HEALTH_DB_PING_TIMEOUT_MS`         | 2000 (`/ready` Postgres ping budget)          |

Prompt prose (investigator contracts) remains in `src/review/prompts/`, `src/agent/prompts/`, `src/agent/ask/`, and `src/agent/description/`.
