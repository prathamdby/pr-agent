# Cancel in-progress review on PR merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a pull request is merged, cooperatively cancel any queued/running orchestrated review for that PR, while leaving `/review` available on merged PRs.

**Architecture:** GitHub sends `pull_request` `closed` with `merged: true` on merge. Durable intake records that delivery, marks active review work items cancelled (queued → `cancelled`, running → `cancel_requested_at`), and cancels matching pg-boss review singleton jobs so the PR slot frees for a later manual `/review`. Slash intake is unchanged and does not gate on merge state.

**Tech Stack:** TypeScript, Zod webhook schemas, Postgres `agent_work_items`, pg-boss `agent-work-review`, vitest.

## Global Constraints

- No GitHub PR-surface I/O on webhook fibers (ADR 0009).
- Cancel reviews only on merge (`closed` + `merged: true`), not on close-without-merge.
- Cancel both `auto` and `slash` review work items for the PR resource key.
- Do not cancel description / verification / ask / triage.
- `/review` must still enqueue on a merged PR once prior review work is terminal.
- Use CONTEXT.md terms: **Orchestrated review run**, **Review superseding**, **Review queue**.
- Domain vocabulary update belongs in `CONTEXT.md`.

## File map

| File                                       | Responsibility                                                                            |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `src/settings/queueConstants.ts`           | Accept `closed` in `AUTOMATED_PR_ACTIONS` (otherwise merge webhooks are ignored at parse) |
| `docs/configuration.md`                    | Document `closed` in `AUTOMATED_PR_ACTIONS`                                               |
| `src/webhook/payloads/pullRequestEvent.ts` | Parse `pull_request.merged`                                                               |
| `src/effect/services/webhookHandlers.ts`   | Pass merge flag into scheduler                                                            |
| `src/agentWork/scheduler.ts`               | Plumb merge flag to applier                                                               |
| `src/agentWork/intake/applier.ts`          | Merge-cancel intake path                                                                  |
| `src/agentWork/autoWorkEnqueue.ts`         | SQL to cancel active reviews by resource key                                              |
| `CONTEXT.md`                               | Glossary for review merge cancel                                                          |
| `test/reviewMergeCancel.test.ts`           | Unit tests for cancel helper + intake routing                                             |
| `test/parseGithubPayload.test.ts`          | `closed` parses; `merged` defaults false                                                  |
| `test/schedulerIgnoredIntake.test.ts`      | closed-without-merge still ignored                                                        |

---

### Task 1: Parse merge flag and cancel active reviews on merge intake

**Files:**

- Modify: `src/webhook/payloads/pullRequestEvent.ts`
- Modify: `src/effect/services/webhookHandlers.ts`
- Modify: `src/agentWork/scheduler.ts`
- Modify: `src/agentWork/intake/applier.ts`
- Modify: `src/agentWork/autoWorkEnqueue.ts`
- Modify: `CONTEXT.md`
- Test: `test/reviewMergeCancel.test.ts`
- Test: `test/schedulerIgnoredIntake.test.ts`

**Interfaces:**

- Consumes: existing `applyAutomatedPullRequestIntake`, `releaseReviewSingletonSlot`, `prResourceKey`, `recordIgnoredWebhook`, `insertWebhookEvent`
- Produces:
  - `cancelActiveReviewsForResource(client, resourceKey) => Promise<readonly string[]>`
  - `applyAutomatedPullRequestIntake(..., options?: { merged?: boolean })`
  - webhook decision `review_cancelled_pr_merged` when merge cancel runs

- [ ] **Step 1: Write failing unit tests**

Cover:

1. `cancelActiveReviewsForResource` marks queued reviews `cancelled` and running reviews `cancel_requested_at` (auto + slash); leaves non-review types alone.
2. `applyAutomatedPullRequestIntake` with `action=closed` and `merged=true` cancels review jobs and records `review_cancelled_pr_merged`.
3. `action=closed` with `merged=false` records `ignored_pull_request_closed` and cancels nothing.
4. Slash uniqueness: after merge cancel of an active slash review, a new slash review insert can succeed (status no longer queued/running).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/reviewMergeCancel.test.ts test/schedulerIgnoredIntake.test.ts`

- [ ] **Step 3: Implement**

1. Add `"closed"` to `AUTOMATED_PR_ACTIONS` in `queueConstants.ts` and update `docs/configuration.md`.
2. Add `merged: z.boolean().optional().default(false)` on `pull_request` in the webhook schema.
3. Pass `data.pull_request.merged === true` from `WebhookHandlers.pullRequest` into `submitAutomatedReview`.
4. In `applyAutomatedPullRequestIntake`, before the planner ignore path:
   - if `action === "closed" && merged === true`, run transactional merge-cancel intake and return.
   - if `action === "closed" && merged !== true`, record `ignored_pull_request_closed` and return.
5. Merge-cancel intake:
   - insert webhook event with decision `review_cancelled_pr_merged` (dedupe-safe).
   - `cancelActiveReviewsForResource` for `prResourceKey(...)`.
   - `releaseReviewSingletonSlot(..., { cancelNonTerminal: cancelledIds.length > 0, cancelWorkItemIds: cancelledIds })`.
   - emit deferred log event with cancelled ids.
6. `cancelActiveReviewsForResource` SQL:
   - queued `type='review'` → `status='cancelled'`, `completed_at=now()`, `last_error='Pull request merged'`.
   - running `type='review'` → `cancel_requested_at = COALESCE(cancel_requested_at, now())`.
   - return all affected ids (auto + slash).
7. CONTEXT.md: add **Review merge cancel** next to **Review superseding**.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/reviewMergeCancel.test.ts test/schedulerIgnoredIntake.test.ts test/intakePlanner.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/webhook/payloads/pullRequestEvent.ts src/effect/services/webhookHandlers.ts src/agentWork/scheduler.ts src/agentWork/intake/applier.ts src/agentWork/autoWorkEnqueue.ts CONTEXT.md test/reviewMergeCancel.test.ts test/schedulerIgnoredIntake.test.ts docs/superpowers/plans/2026-08-01-cancel-review-on-merge.md
git commit -m "feat: cancel in-progress review when a PR is merged"
```

## Verification

- Unit tests above green.
- Manual `/review` path unchanged: no merge-state gate in `slashIntake.ts`.
- Closed-without-merge remains ignored.
