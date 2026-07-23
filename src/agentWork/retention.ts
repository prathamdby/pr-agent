import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import type { Config } from "../config.js";
import { RETENTION_DELETE_BATCH_SIZE, RETENTION_QUEUE } from "../settings/index.js";
import { deleteExpiredResumeSnapshots } from "./resumeSnapshotRepository.js";

const TERMINAL_STATUSES = ["completed", "failed", "cancelled", "superseded"];

export type RetentionResult = {
  readonly workItemsDeleted: number;
  readonly webhookEventsDeleted: number;
  readonly resumeSnapshotsDeleted: number;
};

/**
 * Delete aged terminal work items then webhook events, in batches, so a large
 * backlog never holds one long transaction.
 */
export async function runRetention(
  pool: Pool,
  cfg: Pick<Config, "agentWorkRetentionSeconds" | "webhookEventsRetentionSeconds">,
): Promise<RetentionResult> {
  const [workItemsDeleted, webhookEventsDeleted, resumeSnapshotsDeleted] = await Promise.all([
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
    deleteExpiredResumeSnapshots(pool),
  ]);
  return { workItemsDeleted, webhookEventsDeleted, resumeSnapshotsDeleted };
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
