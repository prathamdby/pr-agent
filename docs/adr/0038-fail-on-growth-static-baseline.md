# ADR 0038 — Fail-on-growth static baseline

## Status

Accepted.

## Context

Agents extend whatever pattern they find and route around rules softer than
the intent. Turning the strictest lint rules on at once needs a big-bang
rewrite of stock violations, so the rules stay soft instead. Stock violations
in `src/**` are small and known: one `console.*` in the `src/index.ts` boot
error path, zero casts, zero `escape()` calls.

## Decision

One JSON file records per-rule violation counts
(`scripts/baselines/static-baseline.json`). One script
(`scripts/check-static-baseline.mjs`) counts lint rules from
`oxlint --format json` and source rules from regex scans over `src/**`,
compares against the baseline, and fails only when a count grows. A smaller
count passes. `--bootstrap` rewrites the baseline from current counts and
refuses when `CI` is set, so the baseline only moves in a local PR. Every
failure prints the file and the fix path. `check:guards` runs the baseline
check, and the `check` CI job runs `check:guards`.

## Consequences

- The strictest rules turn on without rewriting stock code first.
- A PR that adds a banned pattern fails before review with the fix named.
- Shrinking a count lands normally; the baseline shrinks in the same PR.
- Baseline edits are law edits: `CODEOWNERS`-owned and never grown to merge.

## Reversal

Delete the script, the baseline file, the `check:guards` leg, and the CI step.
Violations return to advisory lint output.
