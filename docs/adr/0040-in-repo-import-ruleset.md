# ADR 0040 — In-repo data-driven import ruleset

Architecture edges are rows in `test/architectureRules.test.ts`
(`ImportRule`/`SourceRule`), reusing the walkers from
`test/architectureRulesHelpers.ts`. `pg`/`pg-boss` rows count value
imports only (`import type` is dependency-injection, not a boundary
crossing). Knip was trialled and declined: it could not resolve the then-current
workspace, and the seven-day cooling policy would have blocked installation
of the new dependency.

Prompt import edges are also enforced by the oxlint rule
`pr-agent/prompt-imports` ([ADR 0053](0053-prompt-module-layout.md)).
