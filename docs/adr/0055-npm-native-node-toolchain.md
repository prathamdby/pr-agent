# ADR 0055: npm workspaces and native Node TypeScript

## Decision

Use Node 24.22.0 LTS with npm `>=11.19.1 <12`. The official
`node:24.22.0-bookworm-slim` image supplies npm 11.19.1. Root `engines`
and `devEngines` reject unsupported versions. The supported Node range is
`^24.22.0`, not an unbounded minimum.

One root `package-lock.json` owns the backend and `site` workspace.
Shared overrides stay at the root. `.npmrc` owns `min-release-age=7`,
`legacy-peer-deps=true`, `ignore-scripts=true`, and `engine-strict=true`.
There are no release-age exclusions. Future exclusions match package names
or globs, never exact versions, and require a narrow justification.

| Purpose                       | Installation                                                         |
| ----------------------------- | -------------------------------------------------------------------- |
| Contributor and full checks   | `npm ci`                                                             |
| Backend build and integration | `npm ci --workspaces=false`                                          |
| Backend production            | `npm ci --omit=dev --workspaces=false`                               |
| Landing workspace             | `npm ci --workspace=pr-agent-landing --include-workspace-root=false` |

The migration seeds exact committed resolutions and integrity hashes before
npm normalizes the lock. The root and site dependency layouts remain separate
where hoisting would expose site packages as optional backend peers. Layout
and peer-context changes do not authorize version or integrity changes.
`check:prod-deps` creates an independent frozen production installation,
then queries its installed tree with `npm query`. This avoids full-workspace
development peers and the `npm ls` workspace/legacy-peer diagnostics. It rejects
frontend-only packages, a site workspace link, and framework adapters under
the existing `evlog` boundary. It never treats lockfile flags as installation proof.

Development runs `node --watch --env-file-if-exists=.env src/index.ts`.
TypeScript uses `.ts` relative imports, erasable syntax, and explicit type
imports. Compilation rewrites those references to `.js`; production still
runs `node dist/index.js`. The fff client chooses its real `.ts` source host
or emitted `.js` host and forks with no inherited loader or environment.
Environment and configuration edits can require a manual development restart.
Keep a `.env` file present, even when empty and settings come from exported
variables. Node 24.22.0's watcher can crash on shutdown after a source restart
when `--env-file-if-exists` names an absent file. This reproduces without the
application; it does not affect compiled production or non-watching source runs.

`npm run` forwards script arguments after `--`, for example
`npm run dump-prompt -- all`. `test` explicitly checks Effect versions before
Vitest because disabled lifecycle hooks do not run `pretest`. `verify` is
supported through `npm run verify` and starts its child with the supplied npm CLI.
Fresh-process integration probes use `process.execPath`.

Docker builds and production dependencies install separately, using a BuildKit
npm cache. Native packages must work with lifecycle scripts disabled; no compiler
toolchain is required for those prebuilt artifacts. Runtime retains the official
slim image, Git, certificates, migrations, optional models file, and non-root user.
No package manager or compiler runs in the production process. Removing tooling
from an inherited layer is not an image-size or application-RSS optimization.

CI uses setup-node and root-lockfile caching. The trusted guard workflow installs
and executes only base-branch tooling; PR-head files remain inspection input.
Vercel selects Node 24 from `package.json` engines, installs the site from the root
lock, and builds the workspace. `site/vercel.json` sets commands; its schema does
not accept `nodeVersion`. Dashboard overrides need a separate operator check.

Every `.jsonc` file is a control-plane path, at any depth and case. The canonical
policy blocks triage reads, search, writes, staging, and commits, and verification
search. This intentionally broadens protection, not only write restrictions.

## Validation and rollback

Compare complete dependency inventories, integrity hashes, deterministic prompt
JSON, clean install contracts, and source/compiled native round trips. Run the
backend gates, site build/design checks, and disposable-Postgres verification.
Keep sanitized results, platform checks, and comparable resource measurements in
ignored verification artifacts. Only measured results support performance claims.
Unavailable target-architecture or external checks remain blockers, not passes.

No database changes are introduced. Roll back to the previous application image.
Stop workers cleanly before replacing them; preserve work, leases, intents, and
publish records. Historical test outcomes remain tool-neutral evidence, not
claims about newly executed npm commands.
