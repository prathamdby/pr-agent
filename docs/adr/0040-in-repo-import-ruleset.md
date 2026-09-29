# ADR 0040 — In-repo data-driven import ruleset

Architecture edges are rows in `test/architectureRules.test.ts`
(`ImportRule`/`SourceRule`), reusing the walkers from
`test/architectureRulesHelpers.ts`. `pg`/`pg-boss` rows count value
imports only (`import type` is dependency-injection, not a boundary
crossing). Knip was trialled and declined: it cannot resolve the nub
workspace, and `minimumReleaseAge: 7d` would block `nub ci` on the new dep.
