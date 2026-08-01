# Review Queue Position Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Status:** Implemented in this PR (`getReviewQueuePosition` in `src/agentWork/workItemStateRepository.ts`, Queue row in `src/review/run/progressComment.ts`, ack wiring in `src/agentWork/executors/ackExecutor.ts`).

**Goal:** Show the PR's position in the review wait queue on the queued progress stub (for example `#2 of 10`), matching the existing Head/Source/CI table design.

**Architecture:** Compute position from durable `agent_work_items` (type `review`, status `queued`) at ack publish time. Pass an optional `{ position, total }` into `renderReviewProgressComment`, which adds a Queue table row only on the queued stub when that value is present. Fail soft: omit the row when the work item is missing, not queued, or the lookup fails.

**Tech Stack:** TypeScript, Postgres (`agent_work_items`), Vitest, existing progress-comment HTML table helpers.

## Global Constraints

- User-visible copy and labels live in `src/settings/reviewConstants.ts` (and docs/configuration.md inventory).
- Domain terms from CONTEXT.md: **review progress comment**, **review queue**, **acknowledgement reaction** / ack worker.
- Queued stub remains Head/Source/(CI)/(Queue) only — no Recon/specialist rows until the review worker starts.
- Do not invent synonyms for product concepts; use CONTEXT.md vocabulary.
- Format string is `#${position} of ${total}` (1-based position among queued reviews).
- Position is a snapshot at ack time; no live refresh while still queued.
- Omit Queue row when `tickState` is set (in progress / terminal) or when position is unavailable.
- No new env knobs; no migration (uses existing `created_at` / `status` / `type`).

---

### Task 1: Queue position lookup + render contract

**Files:**

- Modify: `src/agentWork/workItemStateRepository.ts`
- Modify: `src/review/run/progressComment.ts`
- Modify: `src/settings/reviewConstants.ts`
- Modify: `src/settings/index.ts` (only if constants need explicit re-export; barrel already re-exports reviewConstants)
- Modify: `docs/configuration.md` (constant inventory rows)
- Modify: `CONTEXT.md` (one glossary line for queue position on the progress stub)
- Modify: `docs/operations.md` (one sentence under orchestrated reviews / progress stub)
- Test: `test/progressComment.test.ts`
- Test: new `test/reviewQueuePosition.test.ts` (or extend an existing repository unit/integration test if a lighter pattern exists)

**Interfaces:**

- Consumes: `Pool`, `queryOne` / `pool.query`, `renderReviewProgressComment` params, `REVIEW_PROGRESS_*` constants
- Produces:
  - `export type ReviewQueuePosition = { readonly position: number; readonly total: number }`
  - `export async function getReviewQueuePosition(pool: Pool, workItemId: string): Promise<ReviewQueuePosition | null>`
  - `renderReviewProgressComment` gains optional `queuePosition?: ReviewQueuePosition | null`
  - Constants: `REVIEW_PROGRESS_QUEUE_LABEL = "Queue"` and optionally a format helper colocated with render (or `formatReviewQueuePosition(pos): string` returning `#2 of 10`)

**Lookup SQL (single round-trip):**

```sql
WITH target AS (
  SELECT id, created_at
    FROM agent_work_items
   WHERE id = $1
     AND type = 'review'
     AND status = 'queued'
),
queued AS (
  SELECT id, created_at
    FROM agent_work_items
   WHERE type = 'review'
     AND status = 'queued'
)
SELECT
  (SELECT COUNT(*)::int FROM queued q, target t
    WHERE (q.created_at, q.id) <= (t.created_at, t.id)) AS position,
  (SELECT COUNT(*)::int FROM queued) AS total
FROM target;
```

Return `null` when no `target` row (not found / not review / not queued). Validate `position >= 1`, `total >= position` before returning; otherwise `null`.

**Render rules:**

- When `params.tickState == null` and `params.queuePosition` is a valid object, insert table row after Source (before CI): `[Queue, #N of M]` using `renderTableStrong(REVIEW_PROGRESS_QUEUE_LABEL)` and escaped/code-styled value consistent with nearby cells (plain escaped text is fine; do not use `<code>` unless Head-style is required — prefer plain text like Source).
- When `tickState != null`, ignore `queuePosition`.
- NOTE body stays `REVIEW_PROGRESS_QUEUED_NOTE` unchanged.

- [x] **Step 1: Write failing tests** for `format`/`renderReviewProgressComment` with `queuePosition: { position: 2, total: 10 }` → contains Queue + `#2 of 10`; without queuePosition → no Queue row; with tickState → no Queue row even if queuePosition passed; `#1 of 1` works.
- [x] **Step 2: Write failing test** for `getReviewQueuePosition` (unit with mocked pool.query / queryOne, or smallest existing DB test helper) covering: mid-queue rank, sole item, null when status is running.
- [x] **Step 3: Run targeted tests; confirm failure**
- [x] **Step 4: Implement constants, lookup, render wiring**
- [x] **Step 5: Run targeted tests; confirm pass**
- [x] **Step 6: Update CONTEXT.md + docs/configuration.md + docs/operations.md in the same change**

---

### Task 2: Ack worker wires position into the queued stub

**Files:**

- Modify: `src/agentWork/executors/ackExecutor.ts`
- Test: `test/ackExecutor.test.ts`

**Interfaces:**

- Consumes: `getReviewQueuePosition(pool, workItemId)` from `../repository.js` (barrel)
- Produces: `publishAckProgress` passes `queuePosition` into `renderReviewProgressComment` when `data.workItemId` is set; when lookup returns null or `workItemId` is absent, omit (current behavior).

**Failure handling:** Wrap lookup so a DB error logs a warn (`ack_queue_position_failed`) and continues without the Queue row — ack must still post the stub.

- [x] **Step 1: Extend ackExecutor test** — mock `getReviewQueuePosition` (or repository export) to return `{ position: 2, total: 10 }`; assert upserted body matches `/#2 of 10/` and Queue label.
- [x] **Step 2: Extend ackExecutor test** — mock returns null; body has no Queue row / no `#… of …`.
- [x] **Step 3: Implement wiring + warn-on-error**
- [x] **Step 4: Run `npx vitest run test/ackExecutor.test.ts test/progressComment.test.ts test/reviewQueuePosition.test.ts` (or chosen test path); confirm pass**

---

### Task 3: Verify + ship hygiene

**Files:** none beyond fixes from failures

- [x] **Step 1: Run broader related tests if any renderCiSummary / publishReview coordination asserts exact queued table HTML**
- [x] **Step 2: Fix any brittle exact-HTML expectations that omit the optional Queue row**
- [x] **Step 3: deslop → commit → make-pr `--target main`**

## Out of scope

- Live refresh of queue position while still queued
- Ask/description/triage/verification queues
- pg-boss job-table ordering / singleton-key depth (product uses durable work-item FIFO as the user-facing queue)
- Changing NOTE copy or adding env configuration
