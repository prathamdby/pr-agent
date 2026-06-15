import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import type { Config } from "../config.js";
import { RETENTION_QUEUE } from "../settings.js";

const TERMINAL_STATUSES = ["completed", "failed", "cancelled", "superseded"];

export type RetentionResult = {
  readonly workItemsDeleted: number;
  readonly webhookEventsDeleted: number;
};

/**
 * Delete terminal agent work items and aged webhook events. Work items go first so
 * their `webhook_event_id` references clear before the webhook rows are removed
 * (the FK is ON DELETE SET NULL, so either order is safe).
 */
export async function runRetention(
  pool: Pool,
  cfg: Pick<Config, "agentWorkRetentionSeconds" | "webhookEventsRetentionSeconds">,
): Promise<RetentionResult> {
  const [workItems, webhookEvents] = await Promise.all([
    pool.query(
      `DELETE FROM agent_work_items
       WHERE status = ANY($1::text[])
         AND COALESCE(completed_at, updated_at) < now() - ($2::bigint * interval '1 second')`,
      [TERMINAL_STATUSES, cfg.agentWorkRetentionSeconds],
    ),
    pool.query(
      `DELETE FROM webhook_events
       WHERE received_at < now() - ($1::bigint * interval '1 second')`,
      [cfg.webhookEventsRetentionSeconds],
    ),
  ]);
  return {
    workItemsDeleted: workItems.rowCount ?? 0,
    webhookEventsDeleted: webhookEvents.rowCount ?? 0,
  };
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
