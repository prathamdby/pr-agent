# Plan: Commit dogfood `.pr-agent/*.mdc` rules

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add eleven focused `.pr-agent/*.mdc` repo policy rules so pr-agent dogfoods ADR 0025 policy on its own PRs.

**Architecture:** Flat `.pr-agent/` directory of Cursor-style `.mdc` files. Always-apply rules cover settings/import/exhaustiveness; path-scoped rules cover module layout, prompts vs constants, web/worker boundary, topology docs, triage, verification, and site isolation. No TypeScript changes.

**Tech Stack:** Markdown + YAML frontmatter (`.mdc`); validated by existing `src/review/repoPolicy.ts` loader.

**Design:** [docs/superpowers/specs/2026-07-20-pr-agent-repo-rules-design.md](../specs/2026-07-20-pr-agent-repo-rules-design.md)

---

### Task 1: Always-apply rules

**Files:**
- Create: `.pr-agent/settings-knobs.mdc`
- Create: `.pr-agent/esm-imports.mdc`
- Create: `.pr-agent/exhaustive-unions.mdc`

- [ ] Write `settings-knobs.mdc` (no frontmatter or `alwaysApply: true`): magic numbers/defaults only via `src/settings/`; feature/env/constant knob checklist; import via `settings/index.js`; `Config` from `config.ts` at runtime only.
- [ ] Write `esm-imports.mdc`: relative imports use `.js`; import concrete modules, not removed barrels; `src/settings/index.js` is the allowed settings barrel.
- [ ] Write `exhaustive-unions.mdc`: switches over unions/enums need `never` default.
- [ ] Verify each body length ≤ 1000 chars (`wc -c` / character count of body after frontmatter).

### Task 2: Path-scoped product rules

**Files:**
- Create: `.pr-agent/feature-flags.mdc`
- Create: `.pr-agent/module-layout.mdc`
- Create: `.pr-agent/prompt-vs-constants.mdc`
- Create: `.pr-agent/web-worker-boundary.mdc`
- Create: `.pr-agent/topology-diagram.mdc`

- [ ] `feature-flags.mdc` globs: `src/settings/**`, `src/config.ts`, `.env.example`, `docs/features.md`, `docs/configuration.md`, `test/settingsInventory.test.ts`. Body: `FEATURE_*` only; no `ENABLE_*` / `*_AUTO_ACTIONS` / `DESCRIPTION_GENERATE_TITLE`; `FEATURE_REVIEW` has no `off`; invalid modes fail startup; keep `docs/features.md` + inventory test parity.
- [ ] `module-layout.mdc` globs: `src/**`. Body: public entries from `docs/development.md`; import `reviewErrors` from `src/github/reviewErrors.js` not via placement.
- [ ] `prompt-vs-constants.mdc` globs: prompt dirs under `src/review/prompts/**` and `src/agent/{prompts,ask,description,triage,verification}/**` plus `src/settings/**`. Body: long investigator prose stays in prompt modules; only numeric limits / shared user-visible strings in `*Constants.ts`.
- [ ] `web-worker-boundary.mdc` globs: `src/agentWork/**`, `src/effect/**`, `src/webhook/**`, `src/commands/**`. Body: web fiber verify→parse→enqueue→respond; no installation-token mint or PR-surface I/O on web; mint tokens at job execution (ADR 0009).
- [ ] `topology-diagram.mdc` globs: `src/agentWork/**`, `src/effect/**`, `src/index.ts`, `src/worker.ts`, `docker-compose.yml`, `README.md`. Body: topology changes require README Mermaid "How It Works" update in the same PR.

### Task 3: Path-scoped safety / isolation rules

**Files:**
- Create: `.pr-agent/triage-safety.mdc`
- Create: `.pr-agent/verification-publish.mdc`
- Create: `.pr-agent/site-isolation.mdc`

- [ ] `triage-safety.mdc` globs: `src/agent/triage/**`, `src/prWorkspace/writablePrCheckout.ts`, `src/agentWork/executors/triageExecutor.ts`. Body: same-repo only; never force-push/rebase/amend; push-or-nothing before resolve; dismissed needs maintainer evidence and is never auto-resolved by triage; hooks off (`git commit -n`); server-side sensitive-path validation stays.
- [ ] `verification-publish.mdc` globs: `src/agent/verification/**`, `src/agentWork/executors/verificationExecutor.ts`. Body: read-only; no new findings/code edits/writable checkout; one verification stub per thread edited in place; fixed/already-resolved quiet resolve; dismissed → stub + policy suggestion then resolve; stale superseded runs must not publish.
- [ ] `site-isolation.mdc` globs: `site/**`, `package.json`, `scripts/check-production-dependency-graph.mjs`. Body: `site/` is separate landing package; do not pull React/Vite/Next into backend prod graph; backend stays Nub.

### Task 4: Verify loader acceptance

- [ ] Confirm exactly eleven `*.mdc` files under `.pr-agent/` (flat, no subdirs).
- [ ] Run a short Node/ts check or reuse existing test helpers to call `loadRepoPolicy` against the repo root and assert `kind === "ok"` and `policy.rules.length === 11`. Prefer: `nub run test -- test/repoPolicy.test.ts` still passes (unchanged unit tests), plus an ad-hoc script or one-off assertion if needed.
- [ ] Spot-check: no body exceeds 1000 chars; no frontmatter keys other than `globs` / `alwaysApply`.

### Task 5: Ship

- [ ] `deslop` the diff if needed.
- [ ] Commit design, plan, and `.pr-agent/*.mdc` together.
- [ ] Open PR via make-pr / ManagePullRequest against `main`.

## Out of scope

- TypeScript / settings / prompt changes
- Migrating legacy `.pr-agent.yml` (already ignored)
- Adding fixture `.pr-agent` trees under `test/fixtures/`
