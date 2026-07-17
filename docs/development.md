# Development guide

Module layout, import rules, and the runtime topology diagram rubric for **pr-agent**. Agent index (including Cursor Cloud setup): [AGENTS.md](../AGENTS.md).

## Module layout (production)

| Area                 | Path                       | Public entry                                                        |
| -------------------- | -------------------------- | ------------------------------------------------------------------- |
| Review run + publish | `src/review/`              | `run/reviewRun.ts`, `publish/publishReview.ts`                      |
| Local PR workspace   | `src/prWorkspace/`         | `index.ts` (`withPrRepositoryView`)                                 |
| Agent work intake    | `src/agentWork/intake/`    | `planner.ts` (pure), `applier.ts` (Postgres + pg-boss)              |
| Agent work execution | `src/agentWork/executors/` | `index.ts`                                                          |
| Web / worker layers  | `src/agentWork/runtime.ts` | `agentWorkWebLive`, `agentWorkWorkerLive`                           |
| Ask / description    | `src/agent/`               | `ask/askRun.ts`, `description/descriptionRun.ts`                    |
| Agent tool outputs   | `src/agent/tools/`         | `toolOutputBudget.ts`, `localWorkspaceTools.ts`, `context7Tools.ts` |

Import concrete modules (e.g. `src/review/reviewSchema.js`), not removed barrel `index.ts` files. GitHub review error helpers (`isLineResolutionPublishError`, etc.) live in `src/github/reviewErrors.js` — import directly, not via `reviewDiffPlacement.ts`.

Run `nubx knip` after refactors to catch unused exports and files.

## Prompt prose

Long investigator prompt blocks stay in `src/review/prompts/`, `src/agent/prompts/`, `src/agent/ask/`, and `src/agent/description/`. Only numeric limits and shared user-visible strings belong in `settings/constants.ts`.

## README runtime topology diagram

When a change alters **runtime topology**, update the Mermaid diagram in [README.md](../README.md) **How It Works** in the same PR.

**Counts as topology change:** web vs worker responsibilities, Postgres or pg-boss role, webhook route, pg-boss queue lanes, or which executor owns a work type.

**Does not require diagram updates:** prompt tweaks, tool implementation details, publish formatting, or other changes that do not change the diagram's boxes or arrows.
