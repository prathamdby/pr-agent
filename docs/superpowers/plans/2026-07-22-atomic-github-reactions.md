# Plan: Atomic GitHub acknowledgement reactions

**Goal:** Keep exactly one lifecycle reaction (`eyes` | `+1` | `-1`) on each ack target at a time.

**Requirements (user):**

1. Start of work → `eyes`
2. Review/work finishes successfully → `+1` (even if findings/bugs were published)
3. Fail / stop / error → `-1`
4. Atomic: never leave prior lifecycle reactions in place

**Root cause:** `reactOnAckTargets` / `safeReaction` only `create*` reactions. Design doc non-goal said thumbs are additive, so terminal `+1`/`-1` stacks on top of `eyes` (screenshot: 👀 + 👎).

## Approach

1. Treat `eyes` / `+1` / `-1` as a single lifecycle set owned by the bot.
2. Add `setLifecycleReactionOnTargets(...)` in `githubPrSurface.ts` that for each target:
   - lists existing reactions
   - deletes the bot's other lifecycle reactions (`user.id === botUserId` and content in the set, content ≠ desired)
   - creates the desired reaction if the bot does not already have it
3. Route all lifecycle posts through that helper:
   - ack start → `eyes`
   - ack-only complete → `+1`
   - durable complete → `+1` (including when findings were published)
   - durable terminal fail → `-1`
   - Do **not** publish `-1` on cancel/supersede; the replacement run owns the next `eyes` (avoids sticky failure flash)
4. Pass `botUserId` from existing `getAppBotIdentity` / durable cache. If identity lookup fails, still attempt the create; log warn and skip deletes (cannot attribute reactions safely).
5. Update design/docs: remove "additive / keep eyes" non-goal; document replace semantics in `CONTEXT.md` + light ops/ADR wording.

## Out of scope

- Changing check-run pass/fail on findings (unrelated to reactions)
- Reacting on CI-refresh jobs
- Migrating historical stacked reactions already on GitHub
- Outcome reactions on cancelled/superseded work (replacement or operator-driven stop leaves prior reaction until a new lifecycle write)

## Verification

- Unit tests in `githubPrSurface.test.ts`: replace eyes→+1 deletes eyes; replace eyes→-1 deletes eyes; no-op create when desired already present; non-bot reactions untouched
- Ack + durableJob tests assert the set-lifecycle helper / content
- `nub run test` for touched suites; `nub run check:code` if practical

## Files

- `src/agentWork/githubPrSurface.ts`
- `src/agentWork/executors/ackExecutor.ts`
- `src/agentWork/durableJob.ts` (complete / fail / cancel paths)
- `test/githubPrSurface.test.ts`, `test/ackExecutor.test.ts`, durableJob coverage as needed
- `docs/superpowers/specs/2026-07-22-github-reaction-lifecycle-design.md`
- `CONTEXT.md`, `docs/operations.md`, `docs/adr/0009-durable-agent-work.md` (wording only)
