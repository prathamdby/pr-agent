import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import type { Config } from "../config.js";
import { RETENTION_DELETE_BATCH_SIZE, RETENTION_QUEUE } from "../settings/index.js";

const TERMINAL_STATUSES = ["completed", "failed", "cancelled", "superseded"];

export type RetentionResult = {
  readonly workItemsDeleted: number;
  readonly webhookEventsDeleted: number;
};

/**
 * Delete terminal agent work items and aged webhook events. Work items go first so
 * their `webhook_event_id` references clear before the webhook rows are removed
 * (the FK is ON DELETE SET NULL, so either order is safe).
 *
 * Each table is drained in fixed-size batches (`RETENTION_DELETE_BATCH_SIZE`); every
 * batch is its own implicit transaction (`pool.query`) so a large backlog never holds
 * one long open transaction. The two tables run concurrently via `Promise.all`. A
 * batch that deletes fewer rows than the batch size means the table is drained.
 */
export async function runRetention(
  pool: Pool,
  cfg: Pick<Config, "agentWorkRetentionSeconds" | "webhookEventsRetentionSeconds">,
): Promise<RetentionResult> {
  const [workItemsDeleted, webhookEventsDeleted] = await Promise.all([
    (async () => {
      let deleted = 0;
      for (;;) {
        const result = await pool.query(
          `DELETE FROM agent_work_items
            WHERE id IN (
              SELECT id FROM agent_work_items
               WHERE status = ANY($1::text[])
                 AND COALESCE(completed_at, updated_at) < now() - ($2::bigint * interval '1 second')
               LIMIT $3::int
            )`,
          [TERMINAL_STATUSES, cfg.agentWorkRetentionSeconds, RETENTION_DELETE_BATCH_SIZE],
        );
        const batch = result.rowCount ?? 0;
        deleted += batch;
        if (batch < RETENTION_DELETE_BATCH_SIZE) break;
      }
      return deleted;
    })(),
    (async () => {
      let deleted = 0;
      for (;;) {
        const result = await pool.query(
          `DELETE FROM webhook_events
            WHERE id IN (
              SELECT id FROM webhook_events
               WHERE received_at < now() - ($1::bigint * interval '1 second')
               LIMIT $2::int
            )`,
          [cfg.webhookEventsRetentionSeconds, RETENTION_DELETE_BATCH_SIZE],
        );
        const batch = result.rowCount ?? 0;
        deleted += batch;
        if (batch < RETENTION_DELETE_BATCH_SIZE) break;
      }
      return deleted;
    })(),
  ]);
  return { workItemsDeleted, webhookEventsDeleted };
}

export async function ensureRetentionSchedule(
  boss: PgBoss,
  cfg: Pick<Config, "retentionEnabled" | "retentionCron">,
): Promise<void> {
  await boss.createQueue(RETENTION_QUEUE, { policy: "standard" });
  if (cfg.retentionEnabled) {
    await boss.schedule(RETENTION_QUEUE, cfg.retentionCron);
  } else {
    await boss.unschedule(RETENTION_QUEUE);
  }
}
