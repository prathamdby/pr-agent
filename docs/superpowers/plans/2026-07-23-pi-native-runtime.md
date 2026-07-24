# Pi-native agent runtime (#341) — Implementation Plan

> **For agentic workers:** Use prath-mode for all Git ops. Prefer subagent-driven-development with **Composer 2.5** (implement) and **Grok 4.5** (review) when Task/orchestrate is available; main agent always verifies diffs/tests. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace Cursor + generic `AgentRunnerProvider` with a Pi-specific session seam, durability (checkpoints/intents/snapshots), then delete Cursor SDK and exclusive deps — closing #341 / #342–#351 in one PR.

**Architecture:** Feature harnesses talk only to `PiSession` (`src/agent/runtime/`). Raw Pi SDK events stay inside the runtime module; sanitized lifecycle events + metadata audit records cross the seam. Durable Agent phase checkpoints and operation intents guard GitHub mutations; encrypted resume snapshots are short-lived and never override `publish_records`.

**Tech Stack:** TypeScript, Vitest, Postgres migrations, `@earendil-works/pi-coding-agent`, Node `crypto` (AES-256-GCM + HKDF), existing `AppError` / `classifyFailure` / publish-record patterns.

**Estimate:** ~2–4 days of focused agent work (10 sequential sub-issues; durability + call-site migration dominate).

## Global Constraints

- Branch: create `pd/feat/pi-native-runtime` from current HEAD before edits.
- CONTEXT.md vocabulary; add terms only when introducing them (Pi session seam, Agent phase checkpoint, operation intent, resume snapshot).
- Production errors use `AppError` with stable `code`s; never post `AppError.message` on GitHub.
- No inline imports.
- Exhaustive `switch` with `never` default on new unions.
- Trust boundary: no repo-loaded Pi skills/extensions/tools; builtins disabled; instruction files stay untrusted prompt text.
- Snapshots never replay/advance/roll back publish state.
- Fallback only for availability-class failures after retry budget.
- Same-PR docs: configuration, development, operations, ADR 0031, ADR 0013/0015 supersession, AGENTS.md Cursor notes, settings inventory tests.
- Design artifact → commit as `docs/superpowers/specs/2026-07-23-pi-native-runtime-design.md`; plan → `docs/superpowers/plans/2026-07-23-pi-native-runtime.md`.
- Final gate: `nub run check:code`, `nub run test`, production build.
- Git: prath-mode `commit` / `deslop` / `make-pr` only.
- Subagents: **Composer 2.5** and **Grok 4.5** only.

## File map (target)

| Path                                          | Role                                                         |
| --------------------------------------------- | ------------------------------------------------------------ |
| `src/agent/runtime/**`                        | New Pi session seam, policies, sanitizer, durability helpers |
| `migrations/016_agent_runtime_durability.sql` | checkpoints, operation_intents, resume_snapshots             |
| `src/config.ts`, `src/settings/**`            | migration guard, model/thinking/snapshot envs                |
| `src/agent/providers/pi/index.ts`             | Fold into runtime during migrate; delete Cursor tree in #351 |
| `src/agent/providers/cursor/**`               | Delete in Task 10                                            |
| Feature harnesses listed in Task 9            | Switch to `PiSession`                                        |
| `docs/adr/0031-pi-native-agent-runtime.md`    | New ADR                                                      |
| Tests under `test/` mirroring each task       | Seam/harness/contract tests                                  |

## Execution order (DAG)

```
0 docs+branch
→ 1 #342 migration guard
→ 2 #343 Pi session seam + fake
→ 3a #344 events/audit  ║  3b #345 model/fallback  ║  3c #346 thinking
→ 4 #347 compaction (after 3c)
→ 5 #348 checkpoints + op intents
→ 6 #349 encrypted snapshots
→ 7 #350 migrate call sites (after 3a–3c,4,5,6)
→ 8 #351 remove Cursor + deps
→ 9 final verification + PR
```

Parallelism note: after Task 2, Tasks 3a/3b/3c may run as parallel Composer 2.5 chunks with disjoint paths if orchestrate/Task is available; otherwise sequential.

---

### Task 0: Branch, design/plan commit, ADR stub

**Files:**

- Create branch `pd/feat/pi-native-runtime`
- Create: `docs/superpowers/specs/2026-07-23-pi-native-runtime-design.md` (from artifact)
- Create: `docs/superpowers/plans/2026-07-23-pi-native-runtime.md` (from this plan)
- Create: `docs/adr/0031-pi-native-agent-runtime.md` (Accepted; supersedes 0013 + runner-selection of 0015)

**Acceptance:**

- [ ] Branch exists from pre-change HEAD
- [ ] Design + plan + ADR 0031 committed via prath-mode `commit`

---

### Task 1: #342 Legacy Cursor migration guard

**Files:**

- Modify: `src/config.ts` — before accepting `agentProvider === "cursor"`, throw `AppError` `{ code: "config.cursor_provider_removed", message: ... }` naming `AGENT_PROVIDER` and pointing to Pi catalog + `PI_ORCHESTRATOR_*` / `PI_PROVIDER`/`PI_MODEL` / `PI_FALLBACK_*`
- Modify: `src/settings/modelsJson.ts` — keep rejecting `PI_PROVIDER=cursor` with clear message (already partially present)
- Modify: `test/configCursor.test.ts` (or replace with `test/configCursorMigration.test.ts`) — assert error text is actionable; assert `CURSOR_API_KEY` does not become a Pi credential when provider is pi
- Modify: `test/settingsInventory.test.ts` as needed once keys change later (guard phase may keep Cursor keys until Task 8)

**Interfaces:**

- Produces: startup failure for `AGENT_PROVIDER=cursor` with no silent Pi fallback

**Steps:**

- [ ] Write failing config tests for migration error
- [ ] Implement guard in `loadConfig()`
- [ ] Run `nub run test -- test/configCursor.test.ts test/config.test.ts` (or new file)
- [ ] Commit via prath-mode

**Acceptance:** All #342 acceptance criteria.

---

### Task 2: #343 Pi-specific session seam + fake

**Files:**

- Create: `src/agent/runtime/types.ts`, `piSession.ts`, `piSessionImpl.ts`, `fakePiSession.ts`
- Modify: `src/agent/providers/pi/index.ts` — extract shared session construction into `piSessionImpl` **or** have impl call existing helpers; keep `piAgentRunnerProvider` working as a thin wrapper over the new seam for expand compatibility
- Create: `test/piSession.seam.test.ts`, `test/fakePiSession.test.ts`
- Modify: `docs/development.md` module layout row for `src/agent/runtime/`

**Interfaces:**

- Produces: `createPiSession(params)`, `PiSession`, `FakePiSession` supporting send/tools/events/compaction hooks/checkpoint recovery/fallback restart/abort/dispose
- Consumes: existing Pi SDK wiring from `src/agent/providers/pi/index.ts`

**Steps:**

- [ ] Define types + interface (TDD against fake)
- [ ] Implement SDK-backed session with event sink stub
- [ ] Keep `resolveAgentRunnerProvider` + all current call sites green
- [ ] Run `nub run test -- test/piSession.seam.test.ts test/fakePiSession.test.ts test/piAgentRunner.test.ts`
- [ ] Commit

**Acceptance:** All #343 acceptance criteria; no feature harness imports raw `createAgentSession`.

---

### Task 3a: #344 Sanitized lifecycle events + audit

**Files:**

- Create: `src/agent/runtime/lifecycleEvents.ts`, `lifecycleSanitizer.ts`, `agentAudit.ts`
- Wire sanitizer inside `piSessionImpl` before `eventSink`
- Create: `test/agentLifecycleEvents.test.ts`, `test/agentAudit.test.ts`
- Optionally persist audit via lightweight in-memory/log sink first; DB table only if needed for tests (prefer log + structured record type unless issue requires durable table — issue says "audit records"; store as structured log/analytics events unless persistence is required by ops docs; **decision: metadata records via existing analytics/evlog path + typed `AgentAuditRecord`, no new table unless tests demand durability**)

**Acceptance:** #344 criteria; contract tests for allowlist + redaction.

---

### Task 3b: #345 Model policy + fallback classification

**Files:**

- Modify: `src/settings/envKeys.ts`, `defaults.ts`, `src/config.ts`, `docs/configuration.md`, `.env.example`
- Create: `src/agent/runtime/modelPolicy.ts`, `fallbackClassification.ts`
- Create: `test/modelPolicy.test.ts`, `test/fallbackClassification.test.ts`
- Extend `ProviderErrorKind` / classification as needed for transport/5xx/model-unavailable without breaking existing kinds

**Env:**

- `PI_ORCHESTRATOR_PROVIDER` / `PI_ORCHESTRATOR_MODEL` (default → general)
- `PI_FALLBACK_PROVIDER` / `PI_FALLBACK_MODEL` (optional; unset disables fallback)
- Keep `PI_PROVIDER` / `PI_MODEL` as general primary

**Acceptance:** #345 criteria; table-driven eligible/ineligible tests.

---

### Task 3c: #346 Phase-aware thinking policy

**Files:**

- Create: `src/agent/runtime/thinkingPolicy.ts`
- Modify: config for `PI_THINKING_CEILING` (default `high`)
- Create: `test/thinkingPolicy.test.ts`
- Wire `setThinkingLevel` (or create-time level) in `piSessionImpl` per send phase

**Acceptance:** #346 criteria.

---

### Task 4: #347 Compaction with state restoration

**Files:**

- Create: `src/agent/runtime/compactionPolicy.ts`, compaction instruction constants
- Modify: `piSessionImpl` — enable compaction settings; gate on settled turn + no pending op intent; re-inject structured state after compaction_end
- Create: `test/piSession.compaction.test.ts` using fake/harness

**Acceptance:** #347 criteria.

---

### Task 5: #348 Agent phase checkpoints + operation intents

**Files:**

- Create: `migrations/016_agent_runtime_durability.sql` (checkpoints + operation_intents tables; snapshots table may be added here or in Task 6 — **prefer full 016 in Task 5 including snapshots empty schema, Task 6 fills crypto**)
- Create: `src/agent/runtime/checkpoints.ts`, `operationIntents.ts`, repository modules under `src/agentWork/` if that matches existing publish-record style (`src/agentWork/phaseCheckpointRepository.ts`, `operationIntentRepository.ts`)
- Modify publish paths (review/ask/description/triage/verification/CI) to: persist intent → mutate → reconcile publish_record → advance checkpoint
- Create: `test/phaseCheckpoints.test.ts`, `test/operationIntents.crashWindow.test.ts`, extend publish replay tests

**Acceptance:** #348 criteria including crash-window + replay non-duplication.

---

### Task 6: #349 Encrypted resume snapshots

**Files:**

- Create: `src/agent/runtime/resumeSnapshots.ts`, `src/agentWork/resumeSnapshotRepository.ts`
- Modify: config — `AGENT_RESUME_SNAPSHOT_KEY`, `AGENT_RESUME_SNAPSHOT_MARGIN_SECONDS` (default 600)
- Wire retention cleanup in `src/agentWork/retention.ts`
- Create: `test/resumeSnapshots.test.ts` (crypto, tenant isolation, expiry, version mismatch, corruption, missing, early delete, recovery vs restart)

**Acceptance:** #349 criteria.

---

### Task 7: #350 Migrate all feature call sites

**Files:**

- Modify:
  - `src/review/orchestrator/orchestratorRun.ts`
  - `src/review/orchestrator/specialistRun.ts`
  - `src/agent/ask/askRun.ts`
  - `src/agent/description/descriptionRun.ts`
  - `src/agent/triage/triageRunHarness.ts`
  - `src/agent/verification/verificationRunHarness.ts`
  - `src/review/ci/authorCiSummary.ts`
  - `src/agentRun/sessionHelpers.ts` (drop Cursor branches)
  - `src/index.ts` boot path (Pi-only / no cursor boot)
- Update feature tests / helpers (`test/helpers/config.ts`, orchestrator/ask/description suites)
- Ensure no production import of `AgentRunnerProvider` / `resolveAgentRunnerProvider` remains (grep gate)

**Acceptance:** #350 criteria; existing feature tests pass.

---

### Task 8: #351 Remove Cursor code, tests, config, deps

**Files:**

- Delete: `src/agent/providers/cursor/**`, Cursor tests/fixtures, `src/settings/cursorConstants.ts`
- Delete: `AgentRunnerProvider` interface + `resolveAgentRunnerProvider` if unused
- Modify: `package.json` — remove `@cursor/sdk`, `@modelcontextprotocol/sdk`, `sqlite3` from `onlyBuiltDependencies` (confirm no other consumers first)
- Modify: AGENTS.md, configuration/development/operations, ADR 0013/0015 status notes → point to 0031
- Create: `test/dependencyInventory.piRuntime.test.ts` — assert packages absent from package.json and no imports under `src/`
- Run `nub install` after package.json change

**Acceptance:** #351 criteria; `nub run check:code` + full `nub run test` + build.

---

### Task 9: Final verification + PR

**Steps:**

- [ ] Grep gates: no `@cursor/sdk`, no `AGENT_PROVIDER=cursor` support, no `createAgentSession` outside `src/agent/runtime/`
- [ ] `nub run check:code`
- [ ] `nub run test` (and integration tests if persistence suites require them)
- [ ] prath-mode `deslop` then `commit` if needed
- [ ] prath-mode `make-pr` draft PR linking #341 and #342–#351
- [ ] Close-out: note any waived criteria with evidence

**Acceptance:** PR open; CI green or failures triaged; parent issue checklist addressable.

## Testing strategy (summary)

| Area                | How                                                                 |
| ------------------- | ------------------------------------------------------------------- |
| Config migration    | Vitest on `loadConfig` with env fixtures                            |
| Seam                | Fake session unit tests + thin SDK wrapper tests                    |
| Events              | Contract tests on sanitizer allowlist                               |
| Model/fallback      | Table-driven classification                                         |
| Thinking/compaction | Policy unit + harness with fake                                     |
| Durability          | Repo tests + crash-window publish tests                             |
| Inventory           | package.json + import grep tests                                    |
| Regression          | Existing orchestrator/ask/description/triage/verification/CI suites |

## Risks

| Risk                                     | Mitigation                                           |
| ---------------------------------------- | ---------------------------------------------------- |
| Large PR hard to review                  | Commit per task; PR body maps commits → sub-issues   |
| #350 vs durability gap                   | Delivery forces #348/#349 before migration           |
| Snapshot key ops burden                  | Document required worker env; clear startup error    |
| Pi SDK event shape drift                 | Sanitizer + seam tests; don't freeze raw event order |
| MCP/sqlite removal breaks something else | Dependency analysis before delete (Task 8)           |

## Prath-mode / orchestrate ledger (execution)

```
route: Ship planned work (peer-review skipped — user approved autonomy + plan gate)
plan: /opt/cursor/artifacts/PLAN.md
current owner: (pending execution)
subagent models: composer-2.5 (impl), grok-4.5 (review)
terminal: PR URL verified + tests recorded
```
