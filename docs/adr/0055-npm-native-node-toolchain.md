# ADR 0055: npm workspaces and native Node TypeScript

## Decision

Pin contributor tooling, CI, and Docker to Node 26.13.0 LTS with npm
`>=11.19.1 <12`. The official
`node:26.13.0-bookworm-slim` image supplies npm 11.20.0. Root `engines`
and `devEngines` reject unsupported versions. The supported Node range is
`^26.13.0`, not an unbounded minimum. The floor is that pinned LTS
release. The caret accepts 26.13.0 and later 26.x releases, and rejects
every older runtime.

The old `^24.21.0` floor lacked the fix for calling `digest()` after finalizing
an HMAC stream, so do not re-digest a finalized HMAC. Webhook verification and
the inspected authentication dependencies use one-shot HMAC updates and digests.

One root `package-lock.json` owns the backend and `site` workspace.
Shared overrides stay at the root. `.npmrc` owns `min-release-age=7`,
`legacy-peer-deps=true`, `ignore-scripts=true`, and `engine-strict=true`.
`min-release-age-exclude` names only `@tanstack/redact`, so the landing
build can install that package's current release. Every other package
still waits seven days. Exclusions stay package names or globs, never
exact versions.

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
On Node 26.13.0, `node --watch --env-file-if-exists=.env` prints `.env not
found. Continuing without it.` and exits 0 after a source restart and shutdown
when the file is absent.

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
and executes only base-branch tooling. PR-head files remain inspection input.
The Vercel Functions page lists 22.x and 24.x, so the next site deployment
fails. Vercel installs the site from the root lock and builds the workspace.
`site/vercel.json` sets commands. Its schema does not accept `nodeVersion`. The
hosted Node image can bundle npm below the required minimum. Bootstrap npm 11.19.1
into `/tmp/pr-agent-npm` with release-age, engine, and lifecycle-script
protections, then use that binary for both install and build. This leaves the
hosted npm untouched and preserves repository
`devEngines`. Dashboard overrides need a separate operator check.

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
