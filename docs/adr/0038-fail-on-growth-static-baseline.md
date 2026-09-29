# ADR 0038 — Fail-on-growth static baseline

New violations fail the gate; stock never blocks landing. Counts live in
`scripts/baselines/static-baseline.json`, enforced by
`scripts/check-static-baseline.mjs`. Shrinking a count is a normal PR;
growing one fails with the fix path.
