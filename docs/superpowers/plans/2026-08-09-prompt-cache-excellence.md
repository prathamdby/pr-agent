# Prompt cache excellence for Pi agent sessions

Requirements source: https://github.com/prathamdby/pr-agent/issues/423 (body + phase comments 1–7).

**Goal.** Own prompt caching at the Pi session seam: stable system+tools prefix for a session lifetime, explicit short retention, role-scoped OpenAI cache identity, phase safety in executors (not tool-list mutation), role-based auto-compaction, and measurable cache hit rate / write amplification on `review_run_completed`.

**Falsifiable done predicate.** After the change:

1. Feature session create produces a stable session id for the same `(role, specialistId?, provider, model)` and injects `cacheRetention: "short"` on every ModelRuntime stream entry.
2. Orchestrator registers the full tool set once; no production caller of `setActiveTools` / `restoreTools` / `compactIfNeeded` remains (APIs deleted if callerless).
3. Wrong-phase brief / publish_thread / publish_summary return a structured tool error; in-phase calls still accept.
4. Specialist tool definition JSON is identical across the four specialist ids; code-index has one description/schema (unavailable is a result).
5. Compaction enabled only for ask / triage / description / verification; off for orchestrator / specialist / ci_summary.
6. `review_run_completed` snapshot includes `cacheHitRate` and `cacheWriteAmplification` when usage known (null otherwise); `cacheWrite1h` preserved when provider reports it.
7. `nub run check:effect-versions && nub run check:prod-deps && nub run check:code && nub run test && nub run build` pass.

**Delivery.** One PR to `main`, seven commits (one phase each). No new env knobs. No generic caching framework.

## End-state product surface

| Concern                                        | Single owner                                                     |
| ---------------------------------------------- | ---------------------------------------------------------------- |
| Prompt-cache policy (`retention: "short"`)     | `src/agent/runtime/promptCachePolicy.ts`                         |
| Session cache identity → stable id (≤64 chars) | same module + `PiSessionCreateParams`                            |
| Role → compaction enabled                      | `src/agent/runtime/compactionPolicy.ts` (or adjacent role table) |
| Phase → allowed tool names                     | `src/review/orchestrator/phaseToolPolicy.ts`                     |
| Stream retention injection                     | wrap `ModelRuntime.stream*` in `piSessionImpl.ts`                |
| Metrics ratios                                 | `src/review/run/reviewRunMetrics.ts` + usage mapping             |

## Deletes (callerless today)

- `createTestPiSession` alias in `piSession.ts`
- `compactionPolicyFromConfig` in `compactionPolicy.ts`
- Production-unused controlled compact path: `compactIfNeeded` on `PiSession`, reinjection-only helpers that exist solely for it, and public `setExternalMutationPending` if its only purpose was gating that path (keep internal flag if tool metrics still need it)
- Orchestrator `transitionTools` and mid-session `setActiveTools` / `restoreTools` usage
- Specialist submit-only tool stripping via `runSubmitOnlyRound` (gate `submit_findings_report` instead, or leave tools full and nudge)
- Ask finalize `setActiveTools([], {})` — migrate to a finalize gate so `setActiveTools` / `restoreTools` can leave the public session surface
- Duplicate unavailable code-index description/schema (collapse into one tool)

## Phase commits

### Phase 1 — Contract and deletes

- Add ADR `docs/adr/0033-prompt-cache-stability.md`: stable system+tools, short retention, executor phase safety, role-scoped OpenAI cache identity, measurable hit rate.
- Add types: `PromptCachePolicy`, `AgentSessionCacheIdentity` (role, optional specialistId, provider, model).
- Delete `createTestPiSession`, `compactionPolicyFromConfig`.
- No env keys. Behavior unchanged for live sessions.
- Tests: typecheck/lint/fmt; existing runtime tests still pass.

### Phase 2 — Stable tool bytes

- One `searchCodeIndex` description+schema; unavailable is `{ unavailable: true }` result.
- Hoist shared specialist tool list (names, order, descriptions, schemas) so all four specialists match; persona differences stay in system prompts.
- Tests: code-index single description; specialist tool JSON equality across ids.

### Phase 3 — Cache identity seam

- Build stable id from identity; clamp to OpenAI prompt cache key max length (64); validate against SessionManager id charset (`[A-Za-z0-9._-]`).
- Plumb optional `specialistId` through `createFeaturePiSession` / `createPiSession` from `runSpecialist` so specialist cache identity is role+specialist+provider+model (not role-only).
- `SessionManager.inMemory(cwd, { id })`.
- Wrap ModelRuntime `stream` / `streamSimple` (and completes) to set `cacheRetention` from policy (always `"short"` v1). `createAgentSession` does not accept a custom `streamFn`; the ModelRuntime wrap is the seam.
- Pass policy through `createFeaturePiSession` → `createPiSession` from one default. No per-call mode flags.
- ADR note: Anthropic keys on content; OpenAI uses session id as `prompt_cache_key`.
- Tests: stable id for same identity (including specialist differentiation); stream wrapper supplies short retention (spy on stream entry).

### Phase 4 — Compaction by role

- Role map: off for orchestrator, specialist, ci_summary; on for ask, triage, description, verification. SDK auto-compaction only (`SettingsManager` enabled flag).
- Delete `compactIfNeeded` from public `PiSession` + fake; collapse unused reinjection constants if nothing remains.
- Narrow/delete public `setExternalMutationPending` if only used by deleted compact path.
- Tests: create asserts compaction flag by role; no remaining compact API refs.

### Phase 5 — Phase guards (delete tool-list mutation)

- Register full orchestrator tools once (workspace + brief + publish_thread + publish_summary).
- One phase-gate helper for brief / publish_thread / publish_summary executors; wrong phase → structured tool error. Allowed map lives in one module.
- Delete `transitionTools` and repair rounds that singleton-filter tools; keep full list + gate + prompt nudge.
- Rewrite `runSubmitOnlyRound` so it no longer calls `setActiveTools` / `restoreTools`. Production callers today: specialist repair, description, triage, verification. Prefer prompt nudge (+ optional submit gate) with the full tool list left registered. Migrate all four callers in this phase so the public mutation API has zero production callers, then delete it.
- Ask finalize: stop clearing tools (`setActiveTools([], {})`); prompt-only finalize rounds with the full tool list; then delete `setActiveTools` / `restoreTools` from public `PiSession` + fake + impl.
- Interrogate contested safety-vs-cache tradeoff before this commit lands (executor gates vs one-session-per-phase).
- Align orchestrator prompt lines that claim “only tool X” with wrong-tool errors.
- Tests: wrong-phase reject / in-phase accept; tools array unchanged across recon → judgment → synthesis; description/triage/verification/specialist/ask repair or finalize still converge without tool-list mutation.

### Phase 6 — Cache excellence metrics

- Preserve `cacheWrite1h` in usage mapping when present.
- On review-run completed snapshot: `cacheHitRate = cacheRead / (input + cacheRead + cacheWrite)`, `cacheWriteAmplification = cacheWrite / max(cacheRead, 1)`, keep raw totals; null when usage unknown.
- Optional per-role totals only if already separable without a new framework.
- Analytics: forward hit rate only if existing path already forwards token fields.
- Tests: ratio math + null cases.

### Phase 7 — Docs and baselines

- Finish ADR consequences with shipped shape.
- Operations docs: how to read hit rate / write amplification.
- Configuration docs only if a knob shipped (prefer none).
- Fix `models.json.example` cache cost placeholders (stop silent zero without comment).
- CONTEXT.md only if a new product term ships; prefer ADR vocabulary.
- Refresh any baseline fixtures that assumed tool-list mutation.

## Test seams (highest existing)

1. Primary: Pi session create (`createPiSession` / `createFeaturePiSession`).
2. Secondary: orchestrator tool executors (phase policy).
3. Observation: `review_run_completed` metrics snapshot.

## Out of scope

- Long retention default; full conversation resume replay; broad ask/triage/description/verification metrics parity; persona redesign; generic prompt-cache framework; deferred-tool loading; one-session-per-phase.

## Principles shaping this plan

- Subtract-before-add / migrate-then-delete: remove dead compact + tool mutation APIs in the same wave as their replacements.
- Model-the-domain: policy tables (retention, identity, compaction-by-role, phase tools), not scattered flags.
- Laziness: no framework for one feature.
- Sequence-verifiable-units: one phase commit, verify before next.
- Outcome-oriented: reshape to the final surface, not the smallest historical patch.
