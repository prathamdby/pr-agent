# Cursor Cloud specific instructions

Operator setup for Cursor Cloud VMs. Not loaded into ADR 0019 trusted review context (see [AGENTS.md](../AGENTS.md)).

This commit has no `.cursor/` tree and no `environment.json`. Postgres, Node, and Nub are not auto-provisioned. Follow the commands on this page. There is no repo script that installs Docker.

## Services overview

| Service              | How to run                                                                                                                                               | Notes                                                                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Postgres 16          | `docker run -d --name pr-agent-postgres -e POSTGRES_DB=pr_agent -e POSTGRES_USER=pr_agent -e POSTGRES_PASSWORD=pr_agent -p 5432:5432 postgres:16-alpine` | Required for both web and worker roles                                                                                                                 |
| Web (webhook intake) | `ROLE=web nub src/index.ts`                                                                                                                              | Listens on `PORT` (default `3000`; `7224` in `.env.example` and Compose); `GET /health` returns `ok`; `GET /ready` pings Postgres                      |
| Worker (agent work)  | `PORT=3001 ROLE=worker nub src/index.ts`                                                                                                                 | Processes reviews, descriptions, asks, triage, verification, CI refresh, code-index build, and retention. Give web and worker different `PORT` values. |

## Gotchas

- **Install Nub once** — `npm install -g --ignore-scripts=false @nubjs/nub@0.7.2`, then `nub install` in the repo. Node 22.22.0 is pinned in [`.node-version`](../.node-version); Nub provisions it on demand. Prefer `nub install` over repo-root `npm install`. Image and Vercel pin the same Nub version.
- **`PATH` before global npm** — if `/exec-daemon` (or another Node) precedes the nvm Node on `PATH`, `npm install -g` may target `/usr/lib/node_modules` and fail with `EACCES`. Put the pinned Node first (`export PATH="$HOME/.nvm/versions/node/$(cat .node-version)/bin:$PATH"` after `nvm install`/`nvm use`), then install Nub.
- **npm peer deps / Effect** — `.npmrc` sets `legacy-peer-deps=true` so scripts that still call `npm install` can resolve Effect’s strict peer graph (Nub already handles this). After an accidental npm tree, delete `node_modules` and run `nub install`.
- **`GITHUB_APP_PRIVATE_KEY` must be a valid PEM key** — `loadConfig()` calls `crypto.createPrivateKey()` and throws on placeholders. For local-only dev, generate a throwaway key: `openssl genrsa 2048 > key.pem` and set the `.env` value to the escaped content.
- **Docker in cloud VMs** — needs `fuse-overlayfs` storage driver and `iptables-legacy`. Install Docker yourself if the VM does not already have it. Start `dockerd` manually if needed: `sudo dockerd &>/tmp/dockerd.log &`.
- **Unit tests (`nub run test`)** do not need Postgres. **Integration tests** require a reachable DB on the host. Use the services-table `docker run -p 5432:5432` recipe, then `DATABASE_URL=postgres://pr_agent:pr_agent@localhost:5432/pr_agent nub run test:integration` (exits nonzero without Postgres). `docker compose up -d postgres` does not publish `5432`. Inventory-only: `nub run test:integration:inventory`. Use `nub run --node test` if Vitest shows augmentation-related flakiness. Workspace `searchWorkspace` tests invoke the real `git` on `PATH`. Git 2.39.x or newer is enough; shared search does not pass `--max-count`.
- **Lint/fmt commands**: `nub run lint` (oxlint, type-aware), `nub run typecheck` (tsc), `nub run fmt:check` (oxfmt). Combined: `nub run check:code`.
- **Ignored build scripts warning** from Nub is expected for some transitive deps (`esbuild`, `protobufjs`). The worker image does not need a native `sqlite3` build for the agent runtime (see ADR 0023).
- **Vercel site deploys** install pinned Nub via [`site/vercel.json`](../site/vercel.json) (`npm install -g --ignore-scripts=false @nubjs/nub@0.7.2 && cd .. && nub ci --filter pr-agent-landing...`), then `nub --node run build` so Vite runs on plain Node. The repo is Nub identity (`packageManager: nub@0.7.2`, `nub.lock`, install knobs in [`nub.jsonc`](../nub.jsonc)).
