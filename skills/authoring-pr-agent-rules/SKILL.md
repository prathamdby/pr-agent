---
name: authoring-pr-agent-rules
description: >
  Use when seeding, refreshing, or expanding `.pr-agent/*.mdc` repo policy
  rules; when asked to help the PR Agent catch more codebase-specific bugs via
  review policy; when exploring this repo to author Cursor-style `.mdc`
  preference memory; or when tempted to dump conventions into AGENTS.md,
  CONVENTIONS.md, README, or a `pr-agent/` (no-dot) folder instead.
---

# Authoring `.pr-agent` repo policy rules

## Overview

One structured pass → inventory gaps → emit **new** one-gotcha `.mdc` files under **`.pr-agent/`** (leading dot). That directory is the only durable preference memory the PR Agent loads (`REPO_POLICY_DIRNAME` in `src/settings/reviewConstants.ts`, ADR 0025).

**Core principle:** A rule earns its slot only if a careful reviewer of _this_ repo would miss the bug without it.

## Iron Law

```
NO GENERIC ADVICE. NO BLOBS. NO WRONG DIRECTORY. NO DUPLICATES.
```

**No exceptions:**

- Do not ship `CONVENTIONS.md`, handbook dumps, or AGENTS.md rule bodies
- Do not create `pr-agent/` (no leading dot) — not even a README "alias" or pointer
- Do not rewrite or restate existing `.pr-agent/*.mdc` bodies
- Do not keep a giant draft "as reference" while pretending to split later
- Do not fill remaining slots for the sake of filling — stop when the next gap fails the quality bar
- Delete means delete the blob; start from the pass checklist

## One-pass checklist (this repo)

Run **once**, in order. Do not wander.

1. **Inventory** — List every `.pr-agent/*.mdc` filename + one-line gist. Compute `remaining = 20 - count` (`MAX_REPO_POLICY_FILES`). If `remaining === 0`, stop: merge/replace only with explicit human approval; never silently add.
2. **Vocabulary** — Read `CONTEXT.md`. Use product terms only (repo policy rules, web/worker, intake, executors, verification, triage, superseding). No invented synonyms.
3. **Layout** — Read `docs/development.md` module table + existing `.pr-agent/module-layout.mdc`, `esm-imports.mdc`, `web-worker-boundary.mdc`.
4. **Knobs** — Skim `docs/features.md`, `docs/configuration.md`, `.pr-agent/feature-flags.mdc`, `settings-knobs.mdc`, `prompt-vs-constants.mdc`.
5. **Safety surfaces** — Read `.pr-agent/triage-safety.mdc`, `verification-publish.mdc`, `structured-errors.mdc`, `site-isolation.mdc`, `topology-diagram.mdc`.
6. **ADRs** — Skim `docs/adr/` titles/status; open only Accepted ADRs that encode load-bearing invariants not already in an `.mdc`.
7. **Code anchors** — For each candidate gotcha, confirm a concrete path under `src/` or `test/` (grep once). Prefer invariants already enforced in tests (e.g. `test/settingsInventory.test.ts`) but missing from policy.
8. **Gap filter** — Keep only gotchas **absent** from the inventory. Cap emit count at `remaining`. Prefer highest-bug-yield gaps first. Zero new files is a valid outcome.
9. **Write** — One new file per gotcha. Validate each file against the contract below before moving on. Leave unused slots empty rather than minting weak rules.

## Rule file contract

Each file is **exactly** this shape:

```markdown
---
globs:
  - "src/<area>/**"
---

<imperative instruction ≤1000 chars; name modules, constants, ADRs, or test files from THIS repo>
```

| Field            | Rule                                                                         |
| ---------------- | ---------------------------------------------------------------------------- |
| Path             | `.pr-agent/<kebab-gotcha>.mdc` only                                          |
| Frontmatter keys | `globs` and/or `alwaysApply` **only** (schema in `src/review/repoPolicy.ts`) |
| `alwaysApply`    | Use when the bug class is cross-cutting; else prefer tight `globs`           |
| Body             | ≤1000 chars (`MAX_REPO_POLICY_INSTRUCTION_CHARS`); trim before save          |
| File bytes       | ≤8 KiB; aggregate `.pr-agent/` ≤32 KiB; ≤20 files total                      |
| Voice            | Imperative "do / do not"; one concern per file                               |
| Evidence         | Cite resolvable repo paths (`src/...`, `test/...`, `docs/adr/00XX-...`)      |

### Good vs bad body

<Good>
```markdown
---
globs:
  - "src/agent/runtime/**"
  - "src/agent/ask/**"
  - "src/agent/triage/**"
---

Feature harnesses must call `createFeaturePiSession` → `createPiSession` in `src/agent/runtime/piSession.ts`. Do not import `piSessionImpl.ts` or construct raw Pi SDK sessions from feature modules. Keep the web import graph free of Pi/models (`test/webImportGraph.test.ts`, ADR 0031).

````
</Good>

<Bad>
```markdown
Always handle errors properly in async TypeScript code and follow best practices for Node services.
````

</Bad>

## Quality gate (before finish)

For every new `.mdc`:

- [ ] Filename does not collide with inventory
- [ ] Body would fail the "remove brand/repo names — still unique?" test (must stay specific to pr-agent)
- [ ] `wc -m` / character count of body ≤ 1000
- [ ] Frontmatter parses; no extra keys (`description`, `name`, `severity`, …)
- [ ] Total files in `.pr-agent/` ≤ 20 after add
- [ ] Did **not** edit AGENTS.md / CONTEXT.md / docs to restate the rule body

## Common rationalizations

| Excuse                                                    | Reality                                                                                |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| "Generic rules catch real bugs without repo knowledge"    | Loader budget is tiny; generic advice crowds out the gotchas only this repo knows.     |
| "Ship a CONVENTIONS.md blob; split later"                 | Later never comes. PR Agent loads `.pr-agent/*.mdc` only. Blob = zero steering.        |
| "Senior said `pr-agent/` without the dot"                 | `REPO_POLICY_DIRNAME` is `.pr-agent`. Wrong path never loads.                          |
| "Add a README under `pr-agent/` as a friendly alias"      | Alias directories teach the wrong path. Correct the senior; do not create `pr-agent/`. |
| "`.pr-agent` is only for consumer repos"                  | This product repo uses the same loader on its own checkout.                            |
| "Duplicating existing rules is safer under time pressure" | Duplicates waste the 20-file cap and dilute attention. Inventory first.                |
| "Fill all remaining slots so the stakeholder sees volume" | Empty slots beat weak rules. Stop when the quality bar fails.                          |
| "Bodies over 1000 chars are fine; more detail helps"      | Excess is truncated at load — silent loss. Cut to ≤1000.                               |
| "Update AGENTS.md instead; it's always applied"           | AGENTS.md is the pointer index. Binding review prefs are `.pr-agent/*.mdc`.            |

## Red flags — STOP

- Writing `pr-agent/` (no dot), pointer READMEs there, `CONVENTIONS.md`, or `all-rules.mdc`
- Restating TypeScript/Node platitudes with no `src/` or ADR anchor
- Copying an existing `.mdc` under a new name
- Skipping the inventory / remaining-slot math
- Padding weak rules to exhaust remaining slots
- Multi-pass "deep dive later" instead of finishing the one-pass checklist

**All of these mean:** delete the bad outputs. Restart at checklist step 1.

## Done when

Every emitted `.mdc` is new, capped, and codebase-specific; unused slots may remain empty; the quality gate is all checked.
