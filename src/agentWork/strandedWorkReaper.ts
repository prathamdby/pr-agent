import type { IntakeClient } from "../db/postgres.js";
import { logWarn } from "../evlog.js";
import {
  STRANDED_WORK_REAPER_BATCH_SIZE,
  STRANDED_WORK_REAPER_GRACE_SECONDS,
} from "../settings/index.js";

export type StrandedWorkReaperResult = {
  readonly reaped: number;
};

/**
 * Terminalise non-terminal work items that have no live pg-boss job.
 * Cancelled/dead-lettered jobs never redeliver, so stranded rows would otherwise
 * occupy the slash uniqueness slot forever.
 */
export async function reapStrandedWorkItems(pool: IntakeClient): Promise<StrandedWorkReaperResult> {
  const result = await pool.query<{
    id: string;
    type: string;
    prior_status: string;
    resource_key: string;
  }>(
    `WITH stranded AS (
       SELECT wi.id, wi.type, wi.status AS prior_status, wi.resource_key
         FROM agent_work_items wi
        WHERE wi.status IN ('queued', 'running')
          AND wi.updated_at < now() - ($1::bigint * interval '1 second')
          AND NOT EXISTS (
            SELECT 1
              FROM pgboss.job j
             WHERE j.data->>'workItemId' = wi.id::text
               AND j.state IN ('created', 'active', 'retry')
          )
        ORDER BY wi.updated_at ASC
        LIMIT $2::int
        FOR UPDATE OF wi SKIP LOCKED
     )
     UPDATE agent_work_items wi
        SET status = 'cancelled',
            last_error = 'Stranded: no live pg-boss job',
            completed_at = now(),
            updated_at = now(),
            cancel_requested_at = COALESCE(wi.cancel_requested_at, now())
       FROM stranded s
      WHERE wi.id = s.id
      RETURNING wi.id, s.type, s.prior_status, s.resource_key`,
    [STRANDED_WORK_REAPER_GRACE_SECONDS, STRANDED_WORK_REAPER_BATCH_SIZE],
  );

  for (const row of result.rows) {
    logWarn("stranded_work_item_reaped", {
      workItemId: row.id,
      type: row.type,
      priorStatus: row.prior_status,
      resourceKey: row.resource_key,
    });
  }

  return { reaped: result.rows.length };
}
