# Feature Flags Revision — Design

Date: 2026-07-19
Status: Approved (design walkthrough in session; user delegated implementation)

## Problem

`.env.example` holds 88 environment variables. Operator-tuning knobs
(`REVIEW_ANCHOR_MENU_MAX_RANGES_PER_FILE`) sit next to genuine product
features (`DESCRIPTION_GENERATE_TITLE`) with no hierarchy, and feature
enablement is split across `ENABLE_*` booleans and `*_AUTO_ACTIONS` action
sets. Nobody can tell at a glance what the bot does, when it spends tokens,
or which knobs matter.

## Goal

Replace the flat 88-var surface with three tiers:

- **Features** — 8 curated `FEATURE_*` vars, the only settings in
  user-facing docs. Each answers "what does the bot do and when does it
  spend tokens."
- **Ops** — 25 deployment-varying knobs (logging, concurrency, queue
  policy, retention, slash permissions, provider timeout), documented for
  operators only.
- **Infra** — 18 wiring/secret vars, unchanged.

Everything else (~37 vars) is deleted and hardcoded as named constants.

## Feature tier

| Var                     | States                                 | Default  | Replaces                                                       |
| ----------------------- | -------------------------------------- | -------- | -------------------------------------------------------------- |
| `FEATURE_REVIEW`        | `manual` \| `auto`                     | `auto`   | `REVIEW_AUTO_ACTIONS`                                          |
| `FEATURE_DESCRIBE`      | `off` \| `manual` \| `auto`            | `auto`   | `DESCRIPTION_AUTO_ACTIONS`                                     |
| `FEATURE_VERIFICATION`  | `off` \| `auto`                        | `auto`   | `VERIFICATION_AUTO_ACTIONS`                                    |
| `FEATURE_ASK`           | `off` \| `manual`                      | `manual` | new (always-on today)                                          |
| `FEATURE_TRIAGE`        | `off` \| `manual`                      | `manual` | new (always-on today)                                          |
| `FEATURE_REVIEW_LABELS` | `off` \| `effort` \| `effort+security` | `effort` | `ENABLE_REVIEW_LABELS_EFFORT`, `ENABLE_REVIEW_LABELS_SECURITY` |
| `FEATURE_COMMIT_STATUS` | `false` \| `true`                      | `false`  | `ENABLE_REVIEW_COMMIT_STATUS`                                  |
| `FEATURE_TITLE_REWRITE` | `false` \| `true`                      | `false`  | `DESCRIPTION_GENERATE_TITLE`                                   |

Semantics:

- `off` disables the capability entirely: the slash command replies that
  the capability is disabled on this deployment (never a silent ignore),
  no auto-trigger fires, no LLM spend.
- `manual` enables the slash command only.
- `auto` enables the slash command plus hardcoded auto-triggers: review
  and describe on PR `opened`, verification on `synchronize`. Custom
  action sets are removed on purpose; re-adding one is a feature request
  with a human in the loop.
- `FEATURE_REVIEW` has no `off`: review is the product; `/review` always
  works.
- Defaults preserve today's out-of-the-box behavior exactly.

## Ops tier (env-overridable, operator docs only)

- Logging: `LOG_LEVEL`, `LOG_PRETTY`, `LOG_REDACT`
- Concurrency: `REVIEW_CONCURRENCY`, `ASK_CONCURRENCY`,
  `DESCRIPTION_CONCURRENCY`, `TRIAGE_CONCURRENCY`,
  `VERIFICATION_CONCURRENCY`, `ACK_CONCURRENCY`,
  `INSTALLATION_GROUP_CONCURRENCY`
- Queue policy: `QUEUE_RETRY_LIMIT`, `QUEUE_RETRY_DELAY_SECONDS`,
  `QUEUE_RETRY_DELAY_MAX_SECONDS`, `QUEUE_EXPIRE_IN_SECONDS`,
  `QUEUE_HEARTBEAT_SECONDS`, `QUEUE_POLLING_INTERVAL_SECONDS`,
  `QUEUE_RETENTION_SECONDS`, `QUEUE_DELETE_AFTER_SECONDS`,
  `SHUTDOWN_DRAIN_TIMEOUT_SECONDS`
- Retention: `RETENTION_ENABLED`, `RETENTION_CRON`,
  `WEBHOOK_EVENTS_RETENTION_SECONDS`, `AGENT_WORK_RETENTION_SECONDS`
- Access + provider: `SLASH_ALLOWED_ASSOCIATIONS`,
  `PROVIDER_PROMPT_TIMEOUT_MS`

Queue policy stays env-overridable deliberately: docs/agent-work-ops.md
relies on it for incident recovery.

## Infra tier (unchanged)

`PORT`, `ROLE`, `DATABASE_URL`, `GITHUB_APP_ID`,
`GITHUB_APP_PRIVATE_KEY`, `WEBHOOK_SECRET`, `AGENT_PROVIDER`,
`PI_PROVIDER`, `PI_MODEL`, `MODELS_JSON_PATH`, `CURSOR_API_KEY`,
`CURSOR_RIPGREP_PATH`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`GOOGLE_GENERATIVE_AI_API_KEY`, `CONTEXT7_API_KEY`,
`POSTHOG_PROJECT_TOKEN`, `POSTHOG_HOST`.

Fix folded in: `src/posthog.ts` reads token/host from `loadConfig()`
instead of raw `process.env`, closing the one path that bypasses the
config pipeline.

## Hardcoded (env vars deleted, named constants in `src/settings/`)

All remaining limits, timeouts, and caps: the 12 `LOCAL_WORKSPACE_*`
vars, `MAX_TOOL_ROUNDS`, `MAX_TOOL_ROUNDS_DESCRIBE`,
`MAX_TOOL_ROUNDS_TRIAGE`, `MAX_TOOL_ROUNDS_VERIFICATION`,
`MAX_ASK_TOOL_ROUNDS`, `MAX_ASK_FINALIZE_ROUNDS`,
`MAX_REVIEW_PUBLISH_ATTEMPTS`, `MAX_REVIEW_PUBLISH_CALLS`,
`REVIEW_MIN_CONFIDENCE`, `MAX_PR_FILES_LISTED`,
`MAX_PR_FILES_PATCH_BYTES`, `MAX_TRIAGE_FIXES_PER_RUN`,
`REVIEW_CI_SUMMARY_WAIT_MS`, `REVIEW_CI_SUMMARY_WAIT_POLL_MS`,
`REVIEW_CI_SUMMARY_MAX_FAILURES`, `REVIEW_ANCHOR_MENU_MAX_FILES`,
`REVIEW_ANCHOR_MENU_MAX_RANGES_PER_FILE`, `WEBHOOK_MAX_BODY_BYTES`,
`WEBHOOK_TIMEOUT_MS`, `CONTEXT7_RESPONSE_BYTES`, `LOG_MAX_WIDE_EVENTS`.

Current defaults become the constant values. `REVIEW_INJECT_ANCHOR_MENU`
and `REVIEW_REQUIRE_DIFF_CACHE_BEFORE_SUBMIT` become unconditionally
true; their dead branches are removed.

Net: 88 env vars → 51 (8 features + 25 ops + 18 infra).

## Code shape

- `src/config.ts`: new `readFeatureMode()` parser (enum values, throws
  on invalid input); `Config` gains a `features` object
  (`cfg.features.describe === "auto"`); `readAutoActions()` deleted.
- Hardcoded auto-trigger map (feature → `pull_request` actions) lives in
  `src/settings/` next to feature defaults.
- Intake planner/applier/scheduler check feature modes instead of action
  sets. Slash handlers check `off` and reply with a disabled notice.
  `publishReview` reads the labels mode. Anchor-menu and diff-cache
  gates collapse to always-on.
- Demoted knobs become named constants in `src/settings/`, following the
  existing `reviewConstants.ts` pattern.

## Migration — fail fast

`loadConfig()` throws at startup when any removed env var is set, naming
the replacement ("`ENABLE_REVIEW_COMMIT_STATUS` was removed — use
`FEATURE_COMMIT_STATUS`") or stating it is now hardcoded. No aliases, no
deprecation period: a stale deployment gets a human-readable stop, never
silently changed behavior.

## Docs (same PR)

- New `docs/features.md`: the 8 feature vars, states, defaults,
  token-spend implications. Linked from README.
- `docs/configuration.md` slims to infra + ops tiers.
- `.env.example` restructured features-first; deleted vars removed.
- `CONTEXT.md` gains feature-mode vocabulary (feature tier, capability
  modes, token burner).
- `AGENTS.md` "Open when" table gets the features row.

## Testing

- Unit: `readFeatureMode` (valid, invalid, default), removed-var guard
  message, labels mode mapping.
- Behavior: planner honors modes (off/manual/auto per capability), slash
  `off` reply path.
- `test/settingsInventory.test.ts` extended: ENV ↔ `.env.example` parity
  as today, plus every `FEATURE_*` key must appear in `docs/features.md`.

## Out of scope

- Per-repo feature configuration (`.pr-agent/` stays prompt-policy only).
- Custom auto-trigger action sets.
- Any change to core review behavior or defaults.
