---
name: authoring-pr-agent-rules
description: >
  Use when seeding, refreshing, or rebuilding `.pr-agent/*.mdc` repo policy
  rules; when Code Mode, orchestrated review, leases, or loader caps change
  and rules must match current PR Agent; when asked to author Cursor-style
  `.mdc` preference memory for this repo; or when tempted to dump
  conventions into AGENTS.md, CONVENTIONS.md, README, or a `pr-agent/`
  (no-dot) folder instead.
---

# Authoring `.pr-agent` repo policy rules

## Overview

Write one-gotcha `.mdc` files under `.pr-agent/` (leading dot). That
directory is the only durable preference memory the product loads
(`REPO_POLICY_DIRNAME` in `src/settings/reviewConstants.ts`, ADR 0017).

A rule earns its slot only if a careful reviewer of this repo would miss
the bug without it. Author for the current product. Do not author for a
retired harness.

## Iron law

```
NO GENERIC ADVICE. NO BLOBS. NO WRONG DIRECTORY. NO DUPLICATES.
NO RETIRED HARNESS. NO TEACHING EXECUTE.
```

No exceptions:

- Do not ship `CONVENTIONS.md`, handbook dumps, or AGENTS.md rule bodies
- Do not create `pr-agent/` (no leading dot), not even a README alias
- Do not keep a giant draft as reference while pretending to split later
- Do not fill remaining slots for volume. Stop when the next gap fails
  the quality bar
- Do not teach `execute({ code })`, QuickJS, `state`, cell lifecycle, or
  `Promise.all` in a rule body. Product prompts already own the harness
  (`src/agent/prompts/harnessProtocol.ts`, ADR 0033)
- Seed mode does not rewrite existing files
- Refresh mode rebuilds named files from current code. It does not
  polish the old sentences

## Assume the current product

Read `CONTEXT.md` for vocabulary. Then assume these facts. Do not invent
synonyms.

**Investigation.** Review, ask, and verification inspect the PR head
through one model-visible `execute({ code })` QuickJS cell. Workspace
calls are `tools.*` inside the script. Each cell is a fresh context.
`state` is JSON across cells. Host results add `coverage` and
`truncation`. A truncated or refused result cannot prove absence. Bounds
live in `src/settings/codeModeConstants.ts` (80ms guest CPU, 25 host
calls, 4 in flight, 15s wall, marshal array 100, guest string 32 KiB).
One cell cannot inspect a 300-file change set. Description and triage
call native workspace tools. They have no `execute` cell
(`descriptionNativeTooling`, `triageNativeTooling` in
`src/agent/prompts/harnessProtocol.ts`). Repo policy binds on
orchestrated review. Verification reloads it for dismiss suggestions.
Ask, describe, and triage sessions do not load `.mdc` bodies.

**Shared store.** Review builds one execute session store in
`src/review/run/reviewRunSetup.ts` and reuses it for the orchestrator
and the four specialists. Do not write a rule that requires `state` to
survive across specialists. Parallelism is inside one cell
(`Promise.all`, 4 in flight). Two `execute` calls in one turn are
sequential (`src/agent/runtime/toolExecutionMode.ts`).

**Guest catalogue.** Review and ask install all six:
`listChangedFiles`, `readWorkspaceFile`, `searchWorkspace`,
`getWorkspaceDiff`, `getWorkspaceBlame`, `resolveSymbol`. Verification
installs read, search, and diff only. `searchWorkspace` is literal
`git grep`, not regex. Code index and Context7 stay native siblings.
Submit and publish stay native (`submit_findings_report`,
`submit_specialist_brief`, `publish_thread`, `publish_summary`,
`submitVerification`, `submitDescription`, `submitTriage`). Catalogue
generation is `src/agent/codemode/guestCatalogue.ts`.

**Orchestrated review.** Recon authors a specialist brief. Four
specialists run in parallel (correctness, security, quality, tests).
Each ends with `submit_findings_report`. The orchestrator judges and
publishes. Specialist reports are evidence, never authority. The
causal-publication contract is server-owned. `no_findings` is a
successful empty report.

**Binding.** Same-repo head and base identities make matching rules
trusted and binding. Fork, missing, or malformed identity fences them as
untrusted evidence and neutralize forged trust headers. After
findings exist, publish prefilters finding × rule pairs, then one
fail-closed no-tools judge asks for the yes subset only (default no).
Judged-yes paths become a muted `Bound ·` footer. The specialist does
not author a path (`src/review/repoPolicy.ts`,
`src/review/publish/boundPolicyJudge.ts`).

**Agent instruction files.** Root `AGENTS.md`, `CLAUDE.md`, and
`GEMINI.md` load in parallel with repo policy on orchestrated review
only. Separate budgets. No `@include`. Ask, describe, triage, and
verification do not load them (ADR 0019).

**Evidence.** The local PR workspace at `headSha` is the only
publishable code authority (ADR 0024). Findings that cite a path or line
must pass `assertFindingsHaveEvidence` against the work-item
`EvidenceLedger`. Code Mode marshal records delivered file and diff
ranges only, from the marshalled guest result, not the raw host read.
Index and symbol hits are navigation hints.

**Durable work.** Web intake commits `webhook_events` and
`agent_work_items` before success. Workers run review, ask, description,
triage, and verification. Ask is unleased and relies on publish-record
idempotency plus admission quotas before insert (ADR 0031). The other
four take a PR actor lease and fence mutations on the lease epoch
(ADR 0006, ADR 0030). Persist an operation intent before PR-surface
GitHub mutations (`withOperationIntent`). `publish_records` stay
authoritative. Escalated retries follow `retryDispositionFor`
(ADR 0034). Escalation never widens privilege.

**Own verdict and CI.** `closeOwnVerdict` is the only writer for
`PR Agent Review` and optional `pr-agent/review`. Findings conclude
`failure` or `success`. Crash and unpublished runs conclude
`action_required`. `check_run` and `status` deliveries write
`pr_head_ci_state` in the same transaction as `webhook_events` and
enqueue `ci-projection`. The projector is the only later CI-cell writer
(ADR 0035). The model fills `headline` / `reason` / `fixHint` only.

**Feature extras.** Triage preview and bulk apply are the same work
type (ADR 0032). Bulk without a completed preview for that PR head is a
report-only refusal. Description publish merges only the marked agent
block. Server writing policy owns body scale, map mode, and flat
`visuals[]` (ADR 0036).

**Seams.** Features call `createFeaturePiSession` → `createPiSession`.
They do not import `piSessionImpl.ts`. Features call `createPrSurface` /
`PrSurface`. They do not import `prSurfaceImpl.ts` or mint installation
tokens. Web does not perform PR-surface I/O. `site/` is a separate
landing package.

**Large PRs.** Review budget tiers are advisory. They do not cancel an
orchestrated run. Recon inspects changed files through execute cells.
Truncated change sets continue with explicit truncation metadata.
Lightweight docs-only auto completion skips the orchestrated run
(ADR 0010). Slash `/review` is never exempted.

## Modes

Pick one mode. Do not mix them in one pass.

### Seed

Inventory gaps. Emit new files only. Remaining slots equal
`MAX_REPO_POLICY_FILES` (20) minus the current count. If remaining is 0,
stop unless a human names a replace. Zero new files is valid.

### Refresh

Rebuild each named existing file from scratch. Keep the filename. Write
a new body and re-choose globs from current code anchors. Read the old
file only to keep the gotcha identity. Do not edit the old sentences.
Do not add files unless a leftover seed gap still clears the quality
bar.

A refresh is a full rewrite. Whitespace, synonym swaps, and sentence
shuffles fail the gate.

## Code Mode-first bodies

Write the invariant a specialist can check with literal
`searchWorkspace` and focused `readWorkspaceFile` calls across many
changed files.

- Name exact modules, constants, ADRs, and test files from this repo
- Prefer tokens a literal grep can hit (`createPrSurface`,
  `withOperationIntent`, `FEATURE_REVIEW`)
- Keep one concern so the Bound judge can attach one footer
- Prefer tight `globs` on large PRs. Use `alwaysApply` only when the
  bug class is cross-cutting
- Write a check that fits one cell (≤25 host calls, windowed reads).
  Honor marshal caps. Do not demand a full-tree proof
- When the gotcha is the investigation or evidence path, name `tools.*`
  and the EvidenceLedger. Do not narrate cell lifecycle
- When the gotcha is description or triage, assume native workspace
  tools
- Do not write "read every file in order" or sequential native-tool
  essays. Those assume the retired Acorn walker and one-tool-per-turn
  investigation
- Do not write regex search instructions. `searchWorkspace` is literal
- Do not claim a truncated read proves a symbol is absent

## One-pass checklist

Run once, in order. Do not wander.

1. **Mode.** Seed or refresh. Record named refresh files or
   `all existing`.
2. **Inventory.** List every `.pr-agent/*.mdc` filename and a one-line
   gist. Compute remaining slots.
3. **Vocabulary.** Read `CONTEXT.md`. Use product terms only.
4. **Harness.** Read `src/agent/prompts/harnessProtocol.ts`,
   `src/agent/codemode/guestCatalogue.ts`, ADR 0033, and
   `src/settings/codeModeConstants.ts`.
5. **Layout.** Read `docs/development.md` plus
   `.pr-agent/module-layout.mdc`, `esm-imports.mdc`, and
   `web-worker-boundary.mdc` as inventory, not as drafts to keep.
6. **Knobs.** Skim `docs/features.md`, `docs/configuration.md`, and the
   feature-flag, settings-knobs, and prompt-vs-constants rules.
7. **Safety surfaces.** Inventory ask, triage, verification,
   structured-errors, site-isolation, topology-diagram,
   workspace-evidence, operation-intent, Pi, and PrSurface rules.
8. **ADRs.** Skim `docs/adr/` titles. Open Accepted ADRs that encode
   invariants the named files must carry.
9. **Code anchors.** For each file or gap, grep `src/` and `test/`
   once. Prefer invariants already enforced in tests but missing or
   stale in policy.
10. **Write.** Seed emits new files only. Refresh rewrites each named
    file from the anchors. Validate each file against the contract
    before the next.

## Rule file contract

Each file is exactly this shape:

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

Feature harnesses must call `createFeaturePiSession` → `createPiSession` in `src/agent/runtime/piSession.ts`. Do not import `piSessionImpl.ts` or construct raw Pi SDK sessions from feature modules. Keep the web import graph free of Pi/models (`test/webImportGraph.test.ts`, ADR 0023).

````
</Good>

<Good>
```markdown
---
globs:
  - "src/review/**"
  - "src/prWorkspace/**"
  - "src/agent/codemode/**"
  - "src/agent/tools/**"
---

The local PR workspace at the reviewed `headSha` is the sole publishable code authority (ADR 0024). Findings that cite a path or line must pass `assertFindingsHaveEvidence` against the work-item `EvidenceLedger` (`src/review/findings/evidenceValidator.ts`). Code Mode marshal records delivered file and diff ranges. `searchCodeIndex` and `resolveSymbol` hits are navigation hints. Confirm with `tools.readWorkspaceFile` before citing. A truncated host result cannot prove absence.
````

</Good>

<Bad>
```markdown
Always handle errors properly in async TypeScript code and follow best practices for Node services.
```
</Bad>

<Bad>
```markdown
Investigate with `execute({ code })`. Persist `state` across cells. Fan out `tools.*` with `Promise.all` so large PRs finish faster.
```
</Bad>

<Bad>
```markdown
First call `readWorkspaceFile` on every changed path, then `getWorkspaceDiff`, then decide. Use regex grep to find all imports.
```
</Bad>

## Quality gate (before finish)

For every written `.mdc`:

- [ ] Seed: filename does not collide with inventory
- [ ] Refresh: filename is the named existing file
- [ ] Refresh: body is a full rewrite, not a polish of the pre-refresh file
- [ ] Body would fail the "remove brand/repo names, still unique?" test
- [ ] Body names checkable tokens a literal grep can hit
- [ ] Body does not teach `execute`, QuickJS, `state`, or cell lifecycle
- [ ] Body does not assume sequential native workspace tools on review,
      ask, or verification
- [ ] `wc -m` / character count of body ≤ 1000
- [ ] Frontmatter parses; no extra keys (`description`, `name`,
      `severity`, …)
- [ ] Total files in `.pr-agent/` ≤ 20 after the pass
- [ ] Did **not** edit AGENTS.md / CONTEXT.md / docs to restate the
      rule body

## Common rationalizations

| Excuse                                                     | Reality                                                                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| "Generic rules catch real bugs without repo knowledge"     | Loader budget is tiny. Generic advice crowds out the gotchas only this repo knows.                                             |
| "Ship a CONVENTIONS.md blob; split later"                  | Later never comes. The product loads `.pr-agent/*.mdc` only. Blob equals zero steering.                                        |
| "Senior said `pr-agent/` without the dot"                  | `REPO_POLICY_DIRNAME` is `.pr-agent`. Wrong path never loads.                                                                  |
| "Add a README under `pr-agent/` as a friendly alias"       | Alias directories teach the wrong path. Correct the senior. Do not create `pr-agent/`.                                         |
| "`.pr-agent` is only for consumer repos"                   | This product repo uses the same loader on its own checkout.                                                                    |
| "Duplicating existing rules is safer under time pressure"  | Duplicates waste the 20-file cap. Inventory first.                                                                             |
| "Fill all remaining slots so the stakeholder sees volume"  | Empty slots beat weak rules.                                                                                                   |
| "Bodies over 1000 chars are fine; more detail helps"       | Excess is truncated at load. Silent loss. Cut to ≤1000.                                                                        |
| "Update AGENTS.md instead; it is always applied"           | AGENTS.md is the pointer index. Binding review prefs are `.pr-agent/*.mdc`.                                                    |
| "Teach execute in the rule so specialists use Code Mode"   | Product prompts already teach the harness. A rule that restates it wastes the 1000-char cap and goes stale when bounds change. |
| "Refresh means polish the old sentences"                   | Refresh rebuilds from code. Old prose is inventory only.                                                                       |
| "alwaysApply everything so large PRs still see every rule" | The loader already matches globs to changed files. alwaysApply dilutes the Bound judge (default no).                           |
| "Write for sequential native workspace tools / Acorn fuel" | Retired. ADR 0033. Review, ask, and verification investigate through `tools.*` inside execute cells.                           |

## Red flags. Stop

- Writing `pr-agent/` (no dot), pointer READMEs there, `CONVENTIONS.md`,
  or `all-rules.mdc`
- Restating TypeScript or Node platitudes with no `src/` or ADR anchor
- Copying an existing `.mdc` under a new name
- Skipping the inventory / remaining-slot math
- Padding weak rules to exhaust remaining slots
- Teaching `execute`, QuickJS, or cell lifecycle in a rule body
- A refresh that only nits, synonym-swaps, or reshuffles the old body
- Assuming description or triage have an `execute` cell
- Assuming review still has one native tool per workspace read
- Regex search instructions
- Multi-pass "deep dive later" instead of finishing the one-pass
  checklist

All of these mean: delete the bad outputs. Restart at checklist step 1.

## Done when

Seed: every emitted `.mdc` is new, capped, and codebase-specific.
Unused slots may remain empty.

Refresh: every named file is a full rewrite that still passes the
contract. The quality gate is all checked.
