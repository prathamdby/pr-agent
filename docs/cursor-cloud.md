# Cursor Cloud specific instructions

Operator setup for Cursor Cloud VMs. Not loaded into ADR 0027 trusted review context (see [AGENTS.md](../AGENTS.md)).

## Services overview

| Service              | How to run                                                                                                                                               | Notes                                                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Postgres 16          | `docker run -d --name pr-agent-postgres -e POSTGRES_DB=pr_agent -e POSTGRES_USER=pr_agent -e POSTGRES_PASSWORD=pr_agent -p 5432:5432 postgres:16-alpine` | Required for both web and worker roles                                                                                            |
| Web (webhook intake) | `ROLE=web nub src/index.ts`                                                                                                                              | Listens on `PORT` (default `3000`; `7224` in `.env.example` and Compose); `GET /health` returns `ok`; `GET /ready` pings Postgres |
| Worker (agent work)  | `ROLE=worker nub src/index.ts`                                                                                                                           | Processes reviews, descriptions, asks, triage, verification, CI refresh, and retention                                            |

## Gotchas

- **Install Nub once** — `npm install -g --ignore-scripts=false @nubjs/nub`, then `nub install` in the repo. Node 22.22.0 is pinned in [`.node-version`](../.node-version); Nub provisions it on demand. Prefer `nub install` over repo-root `npm install`.
- **`PATH` before global npm** — if `/exec-daemon` (or another Node) precedes the nvm Node on `PATH`, `npm install -g` may target `/usr/lib/node_modules` and fail with `EACCES`. Put the pinned Node first (`export PATH="$HOME/.nvm/versions/node/$(cat .node-version)/bin:$PATH"` after `nvm install`/`nvm use`), then install Nub.
- **npm peer deps / Effect** — `.npmrc` sets `legacy-peer-deps=true` so scripts that still call `npm install` can resolve Effect’s strict peer graph (Nub already handles this). After an accidental npm tree, delete `node_modules` and run `nub install`.
- **`GITHUB_APP_PRIVATE_KEY` must be a valid PEM key** — `loadConfig()` calls `crypto.createPrivateKey()` and throws on placeholders. For local-only dev, generate a throwaway key: `openssl genrsa 2048 > key.pem` and set the `.env` value to the escaped content.
- **Docker in cloud VMs** — needs `fuse-overlayfs` storage driver and `iptables-legacy`. The update script handles Docker installation; start `dockerd` manually if needed: `sudo dockerd &>/tmp/dockerd.log &`.
- **Unit tests (`nub run test`)** do not need Postgres. **Integration tests** require a reachable DB: `docker compose up -d postgres` then `DATABASE_URL=postgres://pr_agent:pr_agent@localhost:5432/pr_agent nub run test:integration` (exits nonzero without Postgres). Inventory-only: `nub run test:integration:inventory`. Use `nub run --node test` if Vitest shows augmentation-related flakiness.
- **Lint/fmt commands**: `nub run lint` (oxlint, type-aware), `nub run typecheck` (tsc), `nub run fmt:check` (oxfmt). Combined: `nub run check:code`.
- **Ignored build scripts warning** from Nub is expected for some transitive deps (`esbuild`, `protobufjs`). The worker image does not need a native `sqlite3` build for the agent runtime (see ADR 0031).
- **Vercel site deploys** install Nub via [`site/vercel.json`](../site/vercel.json) (`install.sh` + `nub ci --filter pr-agent-landing...`), then `nub run build`. The repo is Nub identity (`packageManager: nub@…`, `nub.lock`, install knobs in [`nub.jsonc`](../nub.jsonc)).
