# MDC Repo Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `.pr-agent.yml` with `.pr-agent/*.mdc` rules loaded into review trusted context, and emit `.mdc` append/new policy suggestions.

**Architecture:** `loadRepoPolicy` reads a flat `.pr-agent/` directory of `.mdc` files with optional `globs` / `alwaysApply` frontmatter; `renderRepoPolicyBlock` aggregates matching rule bodies; `renderPolicySuggestionForDismissed` suggests append to the single matching rule file or a new `.mdc`.

**Tech Stack:** TypeScript, Zod (frontmatter shape), `yaml` (frontmatter only), Vitest, Node `fs/promises`.

## Global Constraints

- No dual-read of `.pr-agent.yml`.
- Frontmatter keys: only `globs` and `alwaysApply`.
- Empty scoping frontmatter ⇒ always apply.
- Flat directory only.
- Keep `yaml` dependency (frontmatter parsing).
- Same-PR doc updates: CONTEXT.md, configuration.md, operations.md, new ADR 0025.

### Critical risk mitigation (peer-review)

`RepoPolicy` must expose `rules: RepoPolicyRule[]` (filename, globs, alwaysApply, body) so append selection can count path matches. Update verification/publish tests and triage copy in the same change — do not leave callers assuming YAML `pathInstructions` / `version: 1`.

---

### Task 1: Constants + failing load/render/suggestion tests

**Files:**

- Modify: `src/settings/reviewConstants.ts`
- Modify: `test/repoPolicy.test.ts`
- Create/extend load tests in `test/repoPolicy.test.ts` (temp dirs)

- [ ] **Step 1: Update constants**

Replace YAML filename constants with directory/extension/caps per design spec.

- [ ] **Step 2: Write failing tests** for:
  - absent dir / empty dir → `absent`
  - valid `.mdc` with body, no frontmatter → always included
  - `globs` match / non-match vs `changedFiles`
  - `alwaysApply: true` included even when globs would not match
  - render block lists rule path + body
  - suggestion create-new when absent
  - suggestion append when exactly one matching rule
  - suggestion create-new when zero or 2+ matches
  - no `.pr-agent.yml` references in suggestion output

- [ ] **Step 3: Run tests — expect FAIL**

```bash
export PATH="/home/ubuntu/.nvm/versions/node/v22.22.2/bin:$PATH"
cd /workspace && nub run test -- test/repoPolicy.test.ts
```

---

### Task 2: Implement `repoPolicy.ts`

**Files:**

- Modify: `src/review/repoPolicy.ts`

- [ ] **Step 1: Implement** load/parse/render/suggest per design
- [ ] **Step 2: Pass tests**
- [ ] **Step 3: Commit**

---

### Task 3: Wire executors + publish call sites

**Files:**

- Modify: `src/agentWork/executors/reviewExecutor.ts` (stop reading severityFloor from policy)
- Modify: `src/agent/triage/triageRender.ts` (`.mdc` copy)
- Modify: `test/reviewExecutor.test.ts`
- Modify: `test/publishVerification.test.ts`
- Modify: `test/triageRender.test.ts`
- Modify: `test/verificationExecutor.test.ts` if signatures change

- [ ] Update fixtures from YAML files to `.pr-agent/*.mdc`
- [ ] Expect `severityFloor: undefined` from policy path
- [ ] Expect append/new `.mdc` strings in publish/triage tests
- [ ] Run focused + full test suite

---

### Task 4: Docs + ADR

**Files:**

- Modify: `CONTEXT.md`
- Modify: `docs/configuration.md`
- Modify: `docs/operations.md`
- Create: `docs/adr/0025-mdc-repo-policy.md`

---

### Task 5: Verify + ship

- [ ] `nub run check:code` (or lint/typecheck)
- [ ] `nub run test`
- [ ] deslop → commit → push → PR
