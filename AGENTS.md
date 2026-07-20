# AGENTS.md

Indexer for agents working on **pr-agent**. Open the linked source; do not treat this file as the rulebook.

## What this is

- **Navigation only** — pointers to product language, design, and deeper docs.
- **Progressive disclosure** — read the entry you need; leave the rest closed.
- If a rule already lives elsewhere, **link it; do not restate it**.

## Product (always)

**pr-agent** — GitHub PR agent: automated reviews on `pull_request` events plus `/review`, `/describe`, `/ask`, and `/triage`. Roles: **web** (webhook intake) and **worker** (queues). Topology: [README.md](README.md) "How It Works".

**Language / design:** [CONTEXT.md](CONTEXT.md) is the canonical domain vocabulary. Use those terms; do not invent synonyms.

## Open when

| Need                                       | Source                                                                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Naming, product concepts                   | [CONTEXT.md](CONTEXT.md)                                                                                                |
| Runtime topology                           | [README.md](README.md) "How It Works"                                                                                   |
| Feature catalog (`FEATURE_*`)              | [docs/features.md](docs/features.md)                                                                                    |
| Env, constants, knob checklist             | [docs/configuration.md](docs/configuration.md) · CI: [`test/settingsInventory.test.ts`](test/settingsInventory.test.ts) |
| Modules, imports, prompts, topology rubric | [docs/development.md](docs/development.md)                                                                              |
| Behaviour, deploy, scripts                 | [docs/operations.md](docs/operations.md)                                                                                |
| Queue health / recovery                    | [docs/agent-work-ops.md](docs/agent-work-ops.md)                                                                        |
| Architecture decisions                     | [docs/adr/](docs/adr/)                                                                                                  |
| Cursor Cloud services / gotchas            | [Cursor Cloud specific instructions](#cursor-cloud-specific-instructions) (this file)                                   |

## Same-PR doc updates

| Change                                       | Update                                         |
| -------------------------------------------- | ---------------------------------------------- |
| Domain vocabulary or product concept         | [CONTEXT.md](CONTEXT.md)                       |
| Env, default, or code constant               | [docs/configuration.md](docs/configuration.md) |
| Module layout, entry points, or import rules | [docs/development.md](docs/development.md)     |
| Runtime topology                             | [README.md](README.md) "How It Works"          |
| Behaviour, deploy, or scripts                | [docs/operations.md](docs/operations.md)       |
| Significant architecture decision            | new ADR under [docs/adr/](docs/adr/)           |
| Cursor Cloud setup                           | this file                                      |

Skip doc updates when none of the above apply.

## Cursor Cloud specific instructions

### Services overview

| Service              | How to run                                                                                                                                               | Notes                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Postgres 16          | `docker run -d --name pr-agent-postgres -e POSTGRES_DB=pr_agent -e POSTGRES_USER=pr_agent -e POSTGRES_PASSWORD=pr_agent -p 5432:5432 postgres:16-alpine` | Required for both web and worker roles                       |
| Web (webhook intake) | `ROLE=web nub src/index.ts`                                                                                                                              | Listens on `PORT` (default 7224); `GET /health` returns `ok` |
| Worker (agent work)  | `ROLE=worker nub src/index.ts`                                                                                                                           | Processes reviews, descriptions, asks, and triage            |

### Gotchas

- **Install Nub once** — `npm install -g --ignore-scripts=false @nubjs/nub`, then `nub install` in the repo. Node 22.22.0 is pinned in [`.node-version`](.node-version); Nub provisions it on demand. Prefer `nub install` over repo-root `npm install`.
- **`PATH` before global npm** — if `/exec-daemon` (or another Node) precedes the nvm Node on `PATH`, `npm install -g` may target `/usr/lib/node_modules` and fail with `EACCES`. Put the pinned Node first (`export PATH="$HOME/.nvm/versions/node/$(cat .node-version)/bin:$PATH"` after `nvm install`/`nvm use`), then install Nub.
- **npm peer deps / Effect** — `.npmrc` sets `legacy-peer-deps=true` so scripts that still call `npm install` can resolve Effect’s strict peer graph (pnpm/Nub already handles this). After an accidental npm tree, delete `node_modules` and run `nub install`.
- **`GITHUB_APP_PRIVATE_KEY` must be a valid PEM key** — `loadConfig()` calls `crypto.createPrivateKey()` and throws on placeholders. For local-only dev, generate a throwaway key: `openssl genrsa 2048 > key.pem` and set the `.env` value to the escaped content.
- **Docker in cloud VMs** — needs `fuse-overlayfs` storage driver and `iptables-legacy`. The update script handles Docker installation; start `dockerd` manually if needed: `sudo dockerd &>/tmp/dockerd.log &`.
- **Tests (`nub run test`)** are pure unit/integration tests and do not need Postgres or any running service. Use `nub run --node test` if Vitest shows augmentation-related flakiness.
- **Lint/fmt commands**: `nub run lint` (oxlint, type-aware), `nub run typecheck` (tsc), `nub run fmt:check` (oxfmt). Combined: `nub run check:code`.
- **Ignored build scripts warning** from Nub is expected for some transitive deps (`esbuild`, `protobufjs`). **`sqlite3` is approved** in `package.json` (`pnpm.onlyBuiltDependencies`) because `@cursor/sdk` needs its native binding when `PI_PROVIDER=cursor`. The Docker image compiles `sqlite3` in the `deps` stage (with `python3`/`make`/`g++`) and copies `node_modules` into runtime — do not run a fresh `nub prune --prod` in the final stage without build tools.
- **Vercel site deploys** remain on pnpm via [`site/vercel.json`](site/vercel.json); all other surfaces use Nub in pnpm incumbent mode.
