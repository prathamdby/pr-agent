# Structured AppError — Plan

## Context

Opaque `throw new Error` strings hide failure reasons from ops. We introduce
`AppError` and migrate `src/` throws. PostHog optionality is out of this PR.

## Scope

Included: `AppError` module, log serialization, migrate throws in `src/`, fold
domain error subclasses, docs in `docs/development.md` + design spec.

Excluded: PostHog facade, new feature flags, PR copy rewrites, DB schema changes.

## Constraints

- Preserve `.message` strings used by tests and control flow.
- Preserve `instanceof` for domain error classes.
- No inline imports (dynamic import reserved for later PostHog work).
- Public PR notices never read technical `AppError.message`.

## Alternatives

1. Shared `AppError` + mechanical migration (chosen).
2. Effect TaggedError taxonomy (rejected: most throws are outside Effect).
3. Hot-path-only migration (rejected: user chose whole `src/`).

## Peer review (baked in)

### Critical risk

Migration changes `.message` or drops `instanceof` checks, breaking tests and
stale-head / webhook parse branches.

### Fix

1. Keep exact message strings when converting to `AppError`.
2. Domain classes extend `AppError` and retain class names + fields.
3. Run full test suite before merge; fix any `toThrow` mismatches.

### Verdict

Fix the critical risk first, then ship. (Mitigations above are required in every
migration phase.)

## Applicable skills

deslop, commit, make-pr (prath-mode). poteto Feature playbook for fan-out.

## Phases

1. [phase-1-scaffold.md](./phase-1-scaffold.md) — AppError + tests
2. [phase-2-logging.md](./phase-2-logging.md) — serialize into logError paths
3. [phase-3-migrate.md](./phase-3-migrate.md) — convert throws + domain classes
4. [testing.md](./testing.md) — verification commands

## Verification

`nub run test`, `nub run check:code`

## Implementation guidance

- Principles: outcome-oriented full migration; migrate callers then delete bare
  Error throws we own; encode format in `docs/development.md`; build a small
  helper rather than one-off shapes; sequence verifiable units (scaffold → log
  → migrate batches).
- architect skipped: design already locked with the user in brainstorming.
