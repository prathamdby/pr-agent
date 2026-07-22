# GitHub comment status copy unification

## Goal

Unify PR Agent GitHub user-facing status language (not the marketing site): sentence case, shared icons, one empty-state phrase, and a predictable progress stub that shows Recon + all four specialists from the first post.

## Decisions

- Shared status vocabulary module; layouts stay per surface
- Clean: `✅ No findings` · Counted: `✅ N findings` / `✅ 1 finding`
- Icons: `⏸ Waiting` · `⏳ Running` · `✅ Done` · `✅ No findings` · `✅ N findings` · `⚠️ Failed`
- Note line stays fixed: `Review in progress on the latest commit.`
- Stub always shows rows: Recon, Correctness, Security, Quality, Tests
- Ack: Recon Running, specialists Waiting → after brief: Recon Done, specialists Running → ticks update each specialist

## Critical risk (peer review) and fix

**Risk:** `progressRevision` is `0|1|2|3|4|5` with specialist ticks at `1–4` and terminal/summary at `5`. Inserting a recon-done tick without expanding the space makes `nextProgressRevision` cap at `4`, so the fourth specialist tick is skipped (`currentRevision >= progressRevision`).

**Fix:** Expand to `0|1|2|3|4|5|6`:

| Revision | Meaning                                       |
| -------- | --------------------------------------------- |
| 0        | Ack stub (Recon Running, specialists Waiting) |
| 1        | Recon Done, specialists Running               |
| 2–5      | Specialist completion ticks                   |
| 6        | Terminal tick or final summary                |

## Implementation

1. Add `src/github/statusCopy.ts` (status helpers + phrases)
2. Extend progress tick state with `recon` + specialist `waiting`
3. Ack posts full roster at revision 0
4. Orchestrator ticks revision 1 when brief is ready; specialists start Waiting→Running
5. Render: zero-count `done` and `no_findings` both → `✅ No findings`
6. Sweep other GitHub copy (check run, CI pending, slash/ask/triage/verification constants) to the same voice; no layout rewrites
7. Update tests (`progressComment`, `stubTick`, `ackExecutor`, `orchestratorRun`, summary coordination, CI/check-run where strings change)
8. Touch `CONTEXT.md` / `docs/operations.md` only for the new stub roster behavior

## Out of scope

- Marketing site components
- Full visual parity (HTML tables) on triage/ask/verification
- Changing finding publish behavior or counts (display word only: findings)
