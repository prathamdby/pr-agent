# Agent maintenance rules

## Configuration discoverability

All tunables are catalogued in [docs/configuration.md](docs/configuration.md).

Code entry points:

- **Env-backed defaults** — [src/settings/defaults.ts](src/settings/defaults.ts) and [src/settings/envKeys.ts](src/settings/envKeys.ts); loaded in [src/config.ts](src/config.ts)
- **Code constants** — [src/settings/constants.ts](src/settings/constants.ts), re-exported from [src/settings/index.ts](src/settings/index.ts)

## When you change a knob

| Change                       | Update                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------- |
| New or renamed env var       | `envKeys.ts`, `defaults.ts`, `config.ts`, `.env.example`, `docs/configuration.md` |
| New or changed code constant | `constants.ts`, `docs/configuration.md`                                           |
| Default value only           | `defaults.ts`, `.env.example` (if documented there), `docs/configuration.md`      |

Do not add magic numbers or env default strings in feature modules; import from `src/settings/`.

`docs/configuration.md` code-constant rows are maintained on the honor system. CI enforces env alignment via `test/settingsInventory.test.ts`.

## Prompt prose

Long investigator prompt blocks stay in `src/review/*Prompt*.ts` and `src/agent/*Prompt*.ts` (ask, description, security/quality lenses). Only numeric limits and shared user-visible strings belong in `settings/constants.ts`.

## Module layout (production)

| Area                 | Path                       | Public entry                                           |
| -------------------- | -------------------------- | ------------------------------------------------------ |
| Review run + publish | `src/review/`              | `reviewRun.ts`, `publish/publishReview.ts`             |
| Local PR workspace   | `src/prWorkspace/`         | `index.ts` (`withPrRepositoryView`)                    |
| Agent work intake    | `src/agentWork/intake/`    | `planner.ts` (pure), `applier.ts` (Postgres + pg-boss) |
| Agent work execution | `src/agentWork/executors/` | `index.ts`                                             |
| Web / worker layers  | `src/agentWork/runtime.ts` | `agentWorkWebLive`, `agentWorkWorkerLive`              |
| Ask / description    | `src/agent/`               | `askRun.ts`, `descriptionRun.ts`                       |

Import concrete modules (e.g. `src/review/reviewSchema.js`), not removed barrel `index.ts` files. GitHub review error helpers (`isLineResolutionPublishError`, etc.) live in `src/github/reviewErrors.js` — import directly, not via `reviewDiffPlacement.ts`.

Run `nub dlx knip` after refactors to catch unused exports and files.

## Documentation

### README runtime topology diagram

When a change alters **runtime topology**, update the Mermaid diagram in [README.md](README.md) **How It Works** in the same PR.

**Counts as topology change:** web vs worker responsibilities, Postgres or pg-boss role, webhook route, pg-boss queue lanes, or which executor owns a work type.

**Does not require diagram updates:** prompt tweaks, tool implementation details, publish formatting, or other changes that do not change the diagram’s boxes or arrows.

## Cursor Cloud specific instructions

### Services overview

| Service               | How to run                                                                                                                                               | Notes                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Postgres 16           | `docker run -d --name pr-agent-postgres -e POSTGRES_DB=pr_agent -e POSTGRES_USER=pr_agent -e POSTGRES_PASSWORD=pr_agent -p 5432:5432 postgres:16-alpine` | Required for both web and worker roles                       |
| Web (webhook intake)  | `ROLE=web nub src/index.ts`                                                                                                                              | Listens on `PORT` (default 7224); `GET /health` returns `ok` |
| Worker (reviews/asks) | `ROLE=worker nub src/index.ts`                                                                                                                           | Needs a running web role to receive work                     |

### Gotchas

- **Install Nub once** — `npm install -g --ignore-scripts=false @nubjs/nub`, then `nub install` in the repo. Node 22.22.0 is pinned in [`.node-version`](.node-version); Nub provisions it on demand.
- **`GITHUB_APP_PRIVATE_KEY` must be a valid PEM key** — `loadConfig()` calls `crypto.createPrivateKey()` and throws on placeholders. For local-only dev, generate a throwaway key: `openssl genrsa 2048 > key.pem` and set the `.env` value to the escaped content.
- **Docker in cloud VMs** — needs `fuse-overlayfs` storage driver and `iptables-legacy`. The update script handles Docker installation; start `dockerd` manually if needed: `sudo dockerd &>/tmp/dockerd.log &`.
- **Tests (`nub run test`)** are pure unit/integration tests and do not need Postgres or any running service. Use `nub run --node test` if Vitest shows augmentation-related flakiness.
- **Lint/fmt commands**: `nub run lint` (oxlint, type-aware), `nub run typecheck` (tsc), `nub run fmt:check` (oxfmt). Combined: `nub run check:code`.
- **Ignored build scripts warning** from Nub is expected for some transitive deps (`esbuild`, `protobufjs`). **`sqlite3` is approved** in `package.json` (`pnpm.onlyBuiltDependencies`) because `@cursor/sdk` needs its native binding when `PI_PROVIDER=cursor`. The Docker image compiles `sqlite3` in the `deps` stage (with `python3`/`make`/`g++`) and copies `node_modules` into runtime — do not run a fresh `nub prune --prod` in the final stage without build tools.
- **Vercel site deploys** remain on pnpm via [`site/vercel.json`](site/vercel.json); all other surfaces use Nub in pnpm incumbent mode.
