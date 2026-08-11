import type { Pool, PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import { logWarn } from "../evlog.js";
import { captureEvent } from "../analytics/index.js";
import {
  REVIEW_QUEUE,
  STRANDED_WORK_REAPER_BATCH_SIZE,
  STRANDED_WORK_REAPER_GRACE_SECONDS,
} from "../settings/index.js";
import { pgBossDb } from "../db/postgres.js";
import { reviewSingletonKey } from "./types.js";
import type { SingletonSlotDb } from "./singletonQueue.js";

const TERMINAL_WORK_STATUSES = new Set(["cancelled", "completed", "failed", "superseded"]);

type LiveJobState = "created" | "active" | "retry" | "failed";

function isLiveJobState(state: string): state is LiveJobState {
  return state === "created" || state === "active" || state === "retry" || state === "failed";
}

async function loadTerminalWorkItemIds(
  db: Pick<Pool, "query"> | PoolClient,
  workItemIds: readonly string[],
): Promise<Set<string>> {
  if (workItemIds.length === 0) return new Set();
  const result = await db.query<{ id: string }>(
    `SELECT id::text AS id
       FROM agent_work_items
      WHERE id = ANY($1::uuid[])
        AND status = ANY($2::text[])`,
    [workItemIds, [...TERMINAL_WORK_STATUSES]],
  );
  return new Set(result.rows.map((row) => row.id));
}

/**
 * Clears review singleton jobs that can never run again: failed rows and
 * created/active/retry jobs whose work item is missing or already terminal.
 * Successors waiting in `created` behind those holders can then activate.
 */
export async function releaseOrphanReviewSingletonJobs(
  boss: PgBoss,
  db: Pick<Pool, "query"> | PoolClient,
  resourceKey: string,
  opts?: { readonly connection?: SingletonSlotDb },
): Promise<{ readonly released: number }> {
  const connection = opts?.connection ? { db: opts.connection } : undefined;
  const singletonKey = reviewSingletonKey(resourceKey);
  const jobs = await boss.findJobs<{ workItemId?: string }>(REVIEW_QUEUE, {
    key: singletonKey,
    ...connection,
  });

  const candidateIds = [
    ...new Set(
      jobs
        .filter((job) => isLiveJobState(job.state as string))
        .map((job) => job.data.workItemId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
  const terminalIds = await loadTerminalWorkItemIds(db, candidateIds);

  let released = 0;
  for (const job of jobs) {
    const state = job.state as string;
    if (state === "cancelled" || state === "completed") continue;
    if (state === "failed") {
      await boss.deleteJob(REVIEW_QUEUE, job.id, connection);
      released += 1;
      logWarn("orphan_review_singleton_job_released", {
        resourceKey,
        jobId: job.id,
        state,
        workItemId: job.data.workItemId ?? null,
        reason: "failed_blocker",
      });
      continue;
    }
    if (state !== "created" && state !== "active" && state !== "retry") continue;
    const workItemId = job.data.workItemId;
    const orphan = workItemId == null || workItemId.length === 0 || terminalIds.has(workItemId);
    if (!orphan) continue;
    await boss.cancel(REVIEW_QUEUE, job.id, connection);
    released += 1;
    logWarn("orphan_review_singleton_job_released", {
      resourceKey,
      jobId: job.id,
      state,
      workItemId: workItemId ?? null,
      reason:
        workItemId == null || workItemId.length === 0 ? "missing_work_item" : "terminal_work_item",
    });
  }
  return { released };
}

export type OrphanReviewSingletonReaperResult = {
  readonly released: number;
  readonly staleQueuedLogged: number;
};

/**
 * Diagnostics tick: release orphan review singleton holders, then emit a clear
 * signal for review work items that remain queued past the stranded grace window.
 */
export async function reapOrphanReviewSingletonJobs(
  boss: PgBoss,
  pool: Pool,
): Promise<OrphanReviewSingletonReaperResult> {
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
               AND wi.status IN ('queued', 'running')
          )
        )
      ORDER BY j.created_on ASC
      LIMIT $2::int`,
    [REVIEW_QUEUE, STRANDED_WORK_REAPER_BATCH_SIZE],
  );

  let released = 0;
  for (const row of holders.rows) {
    if (row.state === "failed") {
      await boss.deleteJob(REVIEW_QUEUE, row.job_id);
    } else {
      await boss.cancel(REVIEW_QUEUE, row.job_id);
    }
    released += 1;
    logWarn("orphan_review_singleton_job_released", {
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

/** Intake helper that uses the ambient transaction connection for pg-boss lookups. */
export async function releaseOrphanReviewSingletonJobsInTx(
  boss: PgBoss,
  client: PoolClient,
  resourceKey: string,
): Promise<{ readonly released: number }> {
  return releaseOrphanReviewSingletonJobs(boss, client, resourceKey, {
    connection: pgBossDb(client),
  });
}
