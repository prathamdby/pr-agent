# Development guide

Module layout, import rules, and the runtime topology diagram rubric for **pr-agent**. Agent index (including Cursor Cloud setup): [AGENTS.md](../AGENTS.md).

## Module layout (production)

| Area                 | Path                       | Public entry                                                                                                                                                    |
| -------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Review run + publish | `src/review/`              | `orchestrator/orchestratorRun.ts`, `publish/publishReview.ts`, `ci/analyzeCi.ts` (LLM CI summary: `ci/authorCiSummary.ts`); metrics/footer helpers under `run/` |
| Local PR workspace   | `src/prWorkspace/`         | `index.ts` (`withPrRepositoryView`)                                                                                                                             |
| Agent work intake    | `src/agentWork/intake/`    | `planner.ts` (pure), `applier.ts` (Postgres + pg-boss)                                                                                                          |
| Agent work execution | `src/agentWork/executors/` | `index.ts`                                                                                                                                                      |
| Web / worker layers  | `src/agentWork/runtime.ts` | `agentWorkWebLive`, `agentWorkWorkerLive`                                                                                                                       |
| Ask / description    | `src/agent/`               | `ask/askRun.ts`, `description/descriptionRun.ts`                                                                                                                |
| Agent tool outputs   | `src/agent/tools/`         | `toolOutputBudget.ts`, `localWorkspaceTools.ts`, `context7Tools.ts`                                                                                             |
| Analytics facade     | `src/analytics/`           | `index.ts` (`initAnalytics`, `captureEvent`, `captureException`, `shutdownAnalytics`)                                                                           |

Import concrete modules (e.g. `src/review/reviewSchema.js`), not removed barrel `index.ts` files. GitHub review error helpers (`isLineResolutionPublishError`, etc.) live in `src/github/reviewErrors.js` — import directly, not via `src/review/placement/reviewDiffPlacement.ts`.

## Internal errors (`AppError`)

Production failures use `AppError` from `src/errors/appError.ts`. Do not throw bare
`Error` from `src/`.

| Field     | Rule                                                                    |
| --------- | ----------------------------------------------------------------------- |
| `code`    | Stable `<domain>.<reason_snake>` (e.g. `review.publish_exhausted`)      |
| `message` | Technical why/what/how for logs. Preserve exact strings when migrating. |
| `context` | JSON-safe bag of identifying fields (ids, paths, env names)             |
| `cause`   | Optional underlying error                                               |

Helpers: `isAppError`, `toAppError`, `serializeAppError`, `errorLogFields`.

**PR-facing copy** stays in separate constants / mappers (plain English). Never post
`AppError.message` on a pull request. Domain subclasses (`WebhookParseError`,
`StaleHeadPushError`, `WorkItemPayloadValidationError`) extend `AppError` and keep
their class names for `instanceof` checks.

Design: [docs/superpowers/specs/2026-07-21-structured-apperror-design.md](superpowers/specs/2026-07-21-structured-apperror-design.md).

## Prompt prose

Long investigator prompt blocks stay in `src/review/prompts/`, `src/agent/prompts/`, `src/agent/ask/`, `src/agent/description/`, `src/agent/triage/`, and `src/agent/verification/`. Only numeric limits and shared user-visible strings belong in `src/settings/constants.ts`.

## README runtime topology diagram

When a change alters **runtime topology**, update the Mermaid diagram in [README.md](../README.md) **How It Works** in the same PR.

**Counts as topology change:** web vs worker responsibilities, Postgres or pg-boss role, webhook route, pg-boss queue lanes, or which executor owns a work type.

**Does not require diagram updates:** prompt tweaks, tool implementation details, publish formatting, or other changes that do not change the diagram's boxes or arrows.
