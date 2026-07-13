# Development guide

Module layout, import rules, Cursor Cloud setup, and the runtime topology diagram rubric for **pr-agent**. Index and always-apply rules: [AGENTS.md](../AGENTS.md).

## Module layout (production)

| Area                 | Path                       | Public entry                                                                                      |
| -------------------- | -------------------------- | ------------------------------------------------------------------------------------------------- |
| Review orchestration | `src/review/`              | `run/reviewRun.ts`, `run/reviewEnsemble.ts`, `run/hybridReviewRun.ts`, `publish/publishReview.ts` |
| Review evaluation    | `src/review/evaluation/`   | `reviewComparison.ts`, `reviewReplay.ts`, `reviewShadow.ts`                                       |
| Local PR workspace   | `src/prWorkspace/`         | `index.ts` (`withPrRepositoryView`)                                                               |
| Agent work intake    | `src/agentWork/intake/`    | `planner.ts` (pure), `applier.ts` (Postgres + pg-boss)                                            |
| Agent work execution | `src/agentWork/executors/` | `index.ts`                                                                                        |
| Web / worker layers  | `src/agentWork/runtime.ts` | `agentWorkWebLive`, `agentWorkWorkerLive`                                                         |
| Ask / description    | `src/agent/`               | `ask/askRun.ts`, `description/descriptionRun.ts`                                                  |
| Agent tool outputs   | `src/agent/tools/`         | `toolOutputBudget.ts`, `localWorkspaceTools.ts`, `context7Tools.ts`                               |

Import concrete modules (e.g. `src/review/reviewSchema.js`), not removed barrel `index.ts` files. GitHub review error helpers (`isLineResolutionPublishError`, etc.) live in `src/github/reviewErrors.js` — import directly, not via `reviewDiffPlacement.ts`.

Run `nubx knip` after refactors to catch unused exports and files.

## Prompt prose

Long investigator prompt blocks stay in `src/review/prompts/`, `src/agent/prompts/`, `src/agent/ask/`, and `src/agent/description/`. Only numeric limits and shared user-visible strings belong in `settings/constants.ts`.

The provider-neutral reviewer fan-out, internal report/validation schemas, and synthesis context live in `src/review/run/reviewEnsemble.ts`. Reviewer and validator sessions receive read-only workspace tools; only the orchestrator session assembled by `reviewRun.ts` receives `submitReview`. The hybrid pipeline (`run/hybridReviewRun.ts`) runs four bounded critics (`run/reviewCritics.ts`), one batched validator (`run/reviewValidation.ts`), and one submission-only synthesis turn (`run/reviewSynthesis.ts`); the review executor dispatches between legacy and hybrid based on `REVIEW_PIPELINE_MODE`. Replay and shadow evaluation live in `src/review/evaluation/` and are structurally non-publishing.

## README runtime topology diagram

When a change alters **runtime topology**, update the Mermaid diagram in [README.md](../README.md) **How It Works** in the same PR.

**Counts as topology change:** web vs worker responsibilities, Postgres or pg-boss role, webhook route, pg-boss queue lanes, or which executor owns a work type.

**Does not require diagram updates:** prompt tweaks, tool implementation details, publish formatting, or other changes that do not change the diagram's boxes or arrows.

## Cursor Cloud specific instructions

### Services overview

| Service              | How to run                                                                                                                                               | Notes                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Postgres 16          | `docker run -d --name pr-agent-postgres -e POSTGRES_DB=pr_agent -e POSTGRES_USER=pr_agent -e POSTGRES_PASSWORD=pr_agent -p 5432:5432 postgres:16-alpine` | Required for both web and worker roles                                                                 |
| Web (webhook intake) | `ROLE=web PORT=7224 nub src/index.ts`                                                                                                                    | Listens on `PORT`; `GET /health` liveness; `GET /ready` = Postgres for intake                          |
| Worker (agent work)  | `ROLE=worker PORT=7225 nub src/index.ts`                                                                                                                 | Use a different `PORT` than web when both run on one host; queue consumers + worker `/health` `/ready` |

### Gotchas

- **Install Nub once** — `npm install -g --ignore-scripts=false @nubjs/nub`, then `nub install` in the repo. Node 22.22.0 is pinned in [`.node-version`](../.node-version); Nub provisions it on demand.
- **`GITHUB_APP_PRIVATE_KEY` must be a valid PEM key** — `loadConfig()` calls `crypto.createPrivateKey()` and throws on placeholders. For local-only dev, generate a throwaway key: `openssl genrsa 2048 > key.pem` and set the `.env` value to the escaped content.
- **Docker in cloud VMs** — needs `fuse-overlayfs` storage driver and `iptables-legacy`. The update script handles Docker installation; start `dockerd` manually if needed: `sudo dockerd &>/tmp/dockerd.log &`.
- **Tests (`nub run test`)** are pure unit/integration tests and do not need Postgres or any running service. Use `nub run --node test` if Vitest shows augmentation-related flakiness.
- **Review concurrency has two levels** — `REVIEW_CONCURRENCY` controls durable Review jobs per worker process; each active job runs at most `REVIEW_AGENT_CONCURRENCY` reviewer sessions concurrently before validation and synthesis.
- **Lint/fmt commands**: `nub run lint` (oxlint, type-aware), `nub run typecheck` (tsc), `nub run fmt:check` (oxfmt). Combined: `nub run check:code`.
- **Ignored build scripts warning** from Nub is expected for some transitive deps (`esbuild`, `protobufjs`). **`sqlite3` is approved** in `package.json` (`pnpm.onlyBuiltDependencies`) because `@cursor/sdk` needs its native binding when `PI_PROVIDER=cursor`. The Docker image compiles `sqlite3` in the `deps` stage (with `python3`/`make`/`g++`) and copies `node_modules` into runtime — do not run a fresh `nub prune --prod` in the final stage without build tools.
- **Vercel site deploys** remain on pnpm via [`site/vercel.json`](../site/vercel.json); all other surfaces use Nub in pnpm incumbent mode.
