# Align Docker/docs with Nub start.md + deployment guidance

**Date:** 2026-07-25
**Requirements source:** https://nubjs.com/start.md (+ offline `nub agent docs` for /docs/deployment/docker, /docs/deployment, /docs/install/virtual-store)
**Repo map:** recon memory `/home/ubuntu/.agents/skills/recon/memory/workspace-c52ddf65.md`

## Problem

start.md and current Nub docs say:

- Package-manager provisioning / corepack is subsumed by Nub (`nub pm` / Nub install).
- Docker multi-stage installs should use Nub (`nub ci` / project-local or hoisted self-contained trees) so `node_modules` survives `COPY --from`.
- Hosted builders without a setup step can add `@nubjs/nub` as a devDependency; GH Actions should use `nubjs/setup-nub` (already true here).

Current repo discrepancies:

1. `Dockerfile` prod stage still runs `corepack enable` + `pnpm deploy --prod` because of an outdated comment that Nub's virtual store cannot be copied across stages.
2. README / AGENTS.md / docs/operations.md still frame Vercel as "pnpm until native Nub" without the documented hosted-builder pattern.
3. Local/Docker install instructions only show `npm install -g --ignore-scripts=false @nubjs/nub` (still valid per Nub intro docs) and omit start.md's curl/brew options (docs-only nicety; optional).

Evidence probes (Nub v0.5.0):

- `nub ci` / project-local `.store` is self-contained and COPY-safe.
- `nub deploy` is **not yet supported** (CLI says use `pnpm deploy` for now).
- Corepack-free prod stand-in that is COPY-safe:  
  `nub ci --filter 'pr-agent...'` then `nub prune --prod --filter 'pr-agent...'`  
  (`nub install --prod --node-linker hoisted` left missing top-level links under Docker cache mounts in this repo).

## Out of scope

- Switching lockfile/PM away from pnpm (forbidden by start.md).
- Removing cloud PATH/`EACCES` gotcha for global npm installs in AGENTS.md (still real for Cursor Cloud).
- Installing the global Nub agent skill on the machine (environment-level; not a repo PR concern unless we add a project skill file).

## Plan (independent steps — implement all)

### A. Dockerfile: drop corepack / pnpm deploy

Rewrite multi-stage deps/prod-deps to Nub-only:

1. Keep Node 22.22.0 base and global Nub install (`npm install -g --ignore-scripts=false @nubjs/nub`).
2. Copy workspace manifests **including** `site/package.json` so the lockfile stays valid under frozen installs (stop stripping `site` from `pnpm-workspace.yaml` and stop `--no-frozen-lockfile`).
3. `deps` / build install: `nub ci --filter 'pr-agent...'` (project-local store; includes build tools). Keep a cache mount for Nub's store if useful.
4. `prod-deps`: `FROM deps AS prod-deps` then `RUN nub prune --prod --filter 'pr-agent...'` (keeps project-local `.store` links; drops devDependencies).
5. Allow `site/package.json` through `.dockerignore` (`site/**` + `!site/package.json`) so frozen workspace installs work without pulling the landing app sources.
6. Runtime `COPY` paths must change from `/app/prod/package.json` and `/app/prod/node_modules` to `/app/package.json` and `/app/node_modules`. Keep models.json optional copy, healthcheck, and `CMD ["node", "dist/index.js"]`.
7. Remove `corepack` / `pnpm deploy` entirely.

Verify: `docker build` succeeds (or the buildx path CI's docker job uses). Smoke: container can `node -e "import('effect')"` (or equivalent) with the copied prod tree.

### B. Docs: Vercel / hosted-builder wording

Update README.md, AGENTS.md, docs/operations.md:

- Keep the fact that Vercel still runs its own installer for `site/`.
- Replace "until Vercel has native Nub support" with the current Nub guidance: hosted builders without a setup step keep the platform installer; add `@nubjs/nub` as a devDependency only if scripts need the `nub` binary. Site scripts currently call Vite/`node` directly, so no dependency add is required unless we choose to route site scripts through Nub.
- Do **not** change `site/vercel.json` in this PR unless we also add `@nubjs/nub` and switch scripts (separate optional step C).

### C. Optional (include only if low-risk): route site scripts via Nub on Vercel

If chosen:

1. `nub add -D @nubjs/nub` at repo root (or site package — prefer root workspace).
2. Update `site/vercel.json` install/build to use Nub after the platform can resolve the binary, OR keep pnpm install and change `buildCommand` to invoke `nub` via `node_modules/.bin`.
3. Update docs accordingly.

**Default for this PR:** skip C; docs-only for Vercel (step B), code fix for Dockerfile (step A).

### D. Same-PR doc table

Per AGENTS.md: Dockerfile/deploy behaviour → update docs/operations.md (and README getting-started / AGENTS cloud notes as touched).

## Verification

1. `nub run check:code` (docs/Dockerfile shouldn't affect, but keep green).
2. `nub run test` if any related tests exist (none currently reference Dockerfile).
3. `docker build` for the image (required for A).
4. Confirm grep shows no `corepack` in Dockerfile.
5. Confirm runtime COPY paths no longer reference `/app/prod/`.

## Rollback

Revert the single PR branch; Docker consumers fall back to previous corepack/pnpm deploy path.
