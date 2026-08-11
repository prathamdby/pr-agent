import type { Pool, PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import { captureEvent } from "../analytics/index.js";
import { pgBossDb } from "../db/postgres.js";
import { logWarn } from "../evlog.js";
import {
  REVIEW_QUEUE,
  STRANDED_WORK_REAPER_BATCH_SIZE,
  STRANDED_WORK_REAPER_GRACE_SECONDS,
} from "../settings/index.js";
import type { SingletonSlotDb } from "./singletonQueue.js";
import { ACTIVE_WORK_STATUSES, reviewSingletonKey } from "./types.js";

export type ReviewQueueSlotReleaseResult = {
  readonly released: number;
};

export type ReviewQueueOrphanReapResult = {
  readonly released: number;
  readonly staleQueuedLogged: number;
};

/** Non-empty string work item ids from holding jobs (candidates for an active-row lookup). */
function holdingWorkItemIdCandidates(
  jobs: readonly { readonly state: unknown; readonly data: { readonly workItemId?: unknown } }[],
): string[] {
  return [
    ...new Set(
      jobs
        .filter((job) => isHoldingState(job.state as string))
        .map((job) => job.data.workItemId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
}

/**
 * Active work-item ids among candidates. Compared as text so non-UUID job data
 * cannot abort an intake transaction.
 */
async function loadActiveWorkItemIds(
  db: Pick<Pool, "query"> | PoolClient,
  workItemIds: readonly string[],
): Promise<Set<string>> {
  if (workItemIds.length === 0) return new Set();
  const result = await db.query<{ id: string }>(
    `SELECT id::text AS id
       FROM agent_work_items
      WHERE id::text = ANY($1::text[])
        AND status = ANY($2::text[])`,
    [workItemIds, [...ACTIVE_WORK_STATUSES]],
  );
  return new Set(result.rows.map((row) => row.id));
}

function isHoldingState(state: string): boolean {
  return state === "created" || state === "active" || state === "retry" || state === "failed";
}

function isOrphanWorkItemId(workItemId: unknown, activeIds: ReadonlySet<string>): boolean {
  return typeof workItemId !== "string" || workItemId.length === 0 || !activeIds.has(workItemId);
}

/**
 * Frees the per-PR review queue slot of holders that can never run:
 * failed key_strict_fifo blockers, and created/active/retry jobs whose work
 * item id is missing/empty/non-string or not in an active status
 * (`queued`/`running`). Optionally also cancels jobs for explicit work item
 * ids (slash/merge cancel after those rows are terminalised).
 */
export async function releaseReviewQueueSlot(
  boss: PgBoss,
  db: Pick<Pool, "query"> | PoolClient,
  resourceKey: string,
  opts?: {
    readonly connection?: SingletonSlotDb;
    readonly skipJobId?: string;
    readonly skipWorkItemId?: string;
    readonly cancelWorkItemIds?: readonly string[];
  },
): Promise<ReviewQueueSlotReleaseResult> {
  const connection = opts?.connection ? { db: opts.connection } : undefined;
  const cancelWorkItemIds =
    opts?.cancelWorkItemIds != null ? new Set(opts.cancelWorkItemIds) : null;
  const jobs = await boss.findJobs<{ workItemId?: unknown }>(REVIEW_QUEUE, {
    key: reviewSingletonKey(resourceKey),
    ...connection,
  });

  const activeIds = await loadActiveWorkItemIds(db, holdingWorkItemIdCandidates(jobs));

  let released = 0;
  for (const job of jobs) {
    if (opts?.skipJobId && job.id === opts.skipJobId) continue;
    if (
      opts?.skipWorkItemId &&
      typeof job.data.workItemId === "string" &&
      job.data.workItemId === opts.skipWorkItemId
    ) {
      continue;
    }
    const state = job.state as string;
    if (state === "cancelled" || state === "completed") continue;

    if (state === "failed") {
      await boss.deleteJob(REVIEW_QUEUE, job.id, connection);
      released += 1;
      logWarn("review_queue_slot_released", {
        resourceKey,
        jobId: job.id,
        state,
        workItemId: typeof job.data.workItemId === "string" ? job.data.workItemId : null,
        reason: "failed_blocker",
      });
      continue;
    }

    if (state !== "created" && state !== "active" && state !== "retry") continue;
    const workItemId = job.data.workItemId;
    const explicitCancel =
      typeof workItemId === "string" &&
      cancelWorkItemIds != null &&
      cancelWorkItemIds.has(workItemId);
    const orphan = isOrphanWorkItemId(workItemId, activeIds);
    if (!explicitCancel && !orphan) continue;

    await boss.cancel(REVIEW_QUEUE, job.id, connection);
    released += 1;
    logWarn("review_queue_slot_released", {
      resourceKey,
      jobId: job.id,
      state,
      workItemId: typeof workItemId === "string" ? workItemId : null,
      reason: explicitCancel
        ? "cancel_requested"
        : typeof workItemId !== "string" || workItemId.length === 0
          ? "missing_work_item"
          : "inactive_work_item",
    });
  }
  return { released };
}

/** Intake helper using the ambient transaction connection for pg-boss lookups. */
export async function releaseReviewQueueSlotInTx(
  boss: PgBoss,
  client: PoolClient,
  resourceKey: string,
  opts?: {
    readonly skipJobId?: string;
    readonly skipWorkItemId?: string;
    readonly cancelWorkItemIds?: readonly string[];
  },
): Promise<ReviewQueueSlotReleaseResult> {
  return releaseReviewQueueSlot(boss, client, resourceKey, {
    connection: pgBossDb(client),
    skipJobId: opts?.skipJobId,
    skipWorkItemId: opts?.skipWorkItemId,
    cancelWorkItemIds: opts?.cancelWorkItemIds,
  });
}

/**
 * Diagnostics tick: release orphan review queue holders across keys, then signal
 * reviews that remain queued past the stranded grace window.
 *
 * Orphan rule matches {@link releaseReviewQueueSlot}: failed blockers, or holding
 * jobs whose work item id is missing/empty or not in an active status.
 */
export async function reapReviewQueueOrphans(
  boss: PgBoss,
  pool: Pool,
): Promise<ReviewQueueOrphanReapResult> {
  const holders = await pool.query<{
    job_id: string;
    singleton_key: string;
    state: string;
    work_item_id: string | null;
  }>(
    `SELECT j.id::text AS job_id,
            j.key AS singleton_key,
            j.state::text AS state,
            j.data->>'workItemId' AS work_item_id
       FROM pgboss.job j
      WHERE j.name = $1
        AND j.state IN ('created', 'active', 'retry', 'failed')
        AND (
          j.state = 'failed'
          OR COALESCE(j.data->>'workItemId', '') = ''
          OR NOT EXISTS (
            SELECT 1
              FROM agent_work_items wi
             WHERE wi.id::text = j.data->>'workItemId'
               AND wi.status = ANY($2::text[])
          )
        )
      ORDER BY j.created_on ASC
      LIMIT $3::int`,
    [REVIEW_QUEUE, [...ACTIVE_WORK_STATUSES], STRANDED_WORK_REAPER_BATCH_SIZE],
  );

  let released = 0;
  for (const row of holders.rows) {
    if (row.state === "failed") {
      await boss.deleteJob(REVIEW_QUEUE, row.job_id);
    } else {
      await boss.cancel(REVIEW_QUEUE, row.job_id);
    }
    released += 1;
    logWarn("review_queue_slot_released", {
      singletonKey: row.singleton_key,
      jobId: row.job_id,
      state: row.state,
      workItemId: row.work_item_id,
      reason: row.state === "failed" ? "failed_blocker" : "terminal_or_missing_work_item",
    });
  }

  const staleQueued = await pool.query<{
    id: string;
    resource_key: string;
    age_seconds: string | number;
  }>(
    `SELECT id::text AS id,
            resource_key,
            EXTRACT(EPOCH FROM (now() - created_at)) AS age_seconds
       FROM agent_work_items
      WHERE type = 'review'
        AND status = 'queued'
        AND created_at < now() - ($1::bigint * interval '1 second')
      ORDER BY created_at ASC
      LIMIT $2::int`,
    [STRANDED_WORK_REAPER_GRACE_SECONDS, STRANDED_WORK_REAPER_BATCH_SIZE],
  );

  for (const row of staleQueued.rows) {
    const ageSeconds =
      typeof row.age_seconds === "number" ? row.age_seconds : Number(row.age_seconds);
    logWarn("review_queued_stale", {
      workItemId: row.id,
      resourceKey: row.resource_key,
      ageSeconds: Number.isFinite(ageSeconds) ? Math.floor(ageSeconds) : null,
      graceSeconds: STRANDED_WORK_REAPER_GRACE_SECONDS,
    });
    captureEvent({
      distinctId: "server",
      event: "review queued stale",
      properties: {
        work_item_id: row.id,
        resource_key: row.resource_key,
        age_seconds: Number.isFinite(ageSeconds) ? Math.floor(ageSeconds) : null,
        grace_seconds: STRANDED_WORK_REAPER_GRACE_SECONDS,
      },
    });
  }

  return { released, staleQueuedLogged: staleQueued.rows.length };
}
