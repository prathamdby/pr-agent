# ADR 0063: Landmines oxlint rules

## Status

Accepted. Extends [ADR 0051](0051-no-source-comments.md) for the
Interfere Landmines plugin. Does not move tests, replace the Pi session
seam, or open the `PrSurface` seam ([ADR 0026](0026-pr-surface-seam.md)).

## Context

`@interfere/landmines@0.1.0` publishes ten oxlint rules that keep
AI-written tests and types honest. The package is younger than the
seven-day `min-release-age` gate, so `.npmrc` excludes that package name
only. Oxlint 1.82.0 already loads JS plugins, and `npm run lint` is the
CI lint step, so the rules run there rather than in a second script.

Three of the ten rules contradict a repository standard. Adopting them
would mean dropping seam tests, creating new test files, or renaming the
isolated tests reviewer.

## Decision

1. **Enable these rules at error, with no allowlist and no lowered level.**
   - `landmines-testing/no-fixed-sleep`
   - `landmines-testing/no-flake-masking`
   - `landmines-testing/no-unsignaled-poll`
   - `landmines-testing/strict-msw`
   - `landmines-style/no-comments`
   - `landmines-structure/package-exports`
   - `landmines-types/no-explicit-return-types`

2. **Do not enable these rules.**
   - `landmines-testing/no-test-doubles`. The Pi session seam test replaces
     `runAgentLoop`, and the `PrSurface` seam test replaces installation
     token and publish factories. Those replacements are how the seams are
     tested without a live model or GitHub. Production fakes stay plain
     functions. Isolated reviewers keep `createFakePiSession`.
   - `landmines-structure/colocated-tests`. Tests live in root `test/`.
     Moving them next to `src/` creates new test files, which this
     repository does not do without an explicit request.
   - `landmines-structure/test-file-names`. The only hit is the directory
     `src/prompts/tests/`, the tests reviewer role from
     [ADR 0053](0053-prompt-module-layout.md). The rule also rejects that
     directory name. Root `test/` is singular and is not flagged.

3. **Pin a returned contract where inference would widen it.** A function
   return annotation is removed. A value return is passed through
   `(value: Contract) => value`. An async return uses the `Promise` type
   argument, so a generic `T` still assigns. `void` and `Promise<void>`
   only lose the annotation. Type predicates and `never` stay annotated.
   A recursive function is a typed `const` arrow so the binding carries
   the contract and the body can call it.

4. **Wait on the event a test already has.** A fixed sleep or a poll of a
   spy, length, or size becomes a promise resolved by the handler that
   records the event. A real git, HTTP, or child-process body keeps its
   previous budget in the Vitest config (`slow` project, 90s) or the
   integration config (90s). Per-test `timeout` arguments are removed.
   `vitest.integration.config.ts` already held the suite budget; it now
   matches the slowest crash-recovery test.

## Consequences

`npm run lint` and `npm run lint:backend` fail on a new violation of an
adopted rule. `scripts/forcedOxlintConfig.mjs` still drops `jsPlugins` and the
`landmines-*` rule keys, so the guard oxlint counters do not grow from
the plugin and the guard config still parses. Suppression
markers stay at `lint-suppressions(src)` 4 and `lint-suppressions(test)` 0.
