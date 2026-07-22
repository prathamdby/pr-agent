# Review wall-clock duration (progress stub → pre-summary)

## Problem

The GitHub review run footer shows a wall-clock duration. Today that clock:

- **Starts** when the review worker calls `initReviewRunMetrics` (after claim), not when the progress stub appears.
- **Ends** at an early snapshot inside `publishReviewSummaryOnly`, before CI summary wait and before the final summary upsert.

Users read the duration as “time from stub to finished summary.” Queue delay before the worker starts is missing from the start; CI wait before the summary body is written is also cut off today.

## Goal

Footer duration measures:

1. **Start:** successful progress-stub post (`progressRevision === 0`)
2. **End:** immediately before the final summary body is rendered/upserted (after CI summary prep)

Same clock for lightweight completion.

## Alternatives

| Approach                                                               | Pros                                                                      | Cons                                                  |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------- |
| A. Sticky `detail.stubPostedAtMs` on `progress_comment` publish record | No migration; same write path as stub; worker already loads publish state | Must preserve field across later tick detail replaces |
| B. `agent_work_items.payload.progressStubPostedAtMs`                   | Work-item scoped; immune to shared-row overwrites                         | Extra UPDATE from ack; payload shape growth           |
| C. Infer from `progress_comment.updated_at` / check-run `started_at`   | Zero new fields                                                           | Wrong under ticks / races                             |

**Choice: A.** Smallest durable handoff. Merge `stubPostedAtMs` into every later `progress_comment` detail write so ticks cannot erase it.

## Design

### Data

On successful `progress_comment` publish with `progressRevision === 0`, store:

```json
{ "progressRevision": 0, "updated": true, "stubPostedAtMs": 1710000000000 }
```

Later revisions keep the same `stubPostedAtMs` and update `progressRevision` / `updated`.

Reader: `getProgressStubPostedAtMs(pool, resourceKey, reviewLens) → number | null`.

### Duration resolve

Pure helper:

```ts
resolveReviewWallClockMs({
  stubPostedAtMs,
  metricsStartedAtMs,
  endedAtMs,
}): number
```

Precedence for start: `stubPostedAtMs` → `metricsStartedAtMs` → `endedAtMs` (duration `0`). Clamp negative to `0`.

### Call sites

1. **`upsertSummaryCommentAtRevision`** — write/preserve `stubPostedAtMs` in detail.
2. **`publishReviewSummaryOnly`** — after `buildCiSummary`, freeze `endedAtMs = Date.now()`, resolve duration, pass into `runFooter.durationMs`.
3. **`tryLightweightAutoReviewCompletion`** — same resolve using durable stub time + metrics fallback.
4. **`initReviewRunMetrics`** (optional) — accept `startedAtMs` so logs/metrics align when stub time is already known at worker start.

### Fallback

Missing `stubPostedAtMs` (pre-deploy rows, stub skipped): use in-process metrics `startedAtMs`, else `0`.

### Docs

Update `CONTEXT.md` **Review run footer** to define start/end. No env knobs; no ADR (behavior clarification, not a new architecture).

## Tests

- Sticky `stubPostedAtMs` across progress revisions
- `resolveReviewWallClockMs` precedence and clamps
- Summary publish footer uses stub start and freezes after CI wait
- Lightweight completion uses the same resolver

## Out of scope

- Changing footer copy/format
- Persisting duration on the summary publish record
- Backfilling historical comments
