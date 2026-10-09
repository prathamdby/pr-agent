import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { type Config, RETENTION_DELETE_BATCH_SIZE, RETENTION_QUEUE } from "../settings/index.js";
import { logWarn } from "../evlog.js";
import { deleteExpiredAskQuotaState } from "./askQuota.js";
import { deleteExpiredPrHeadCiState } from "./prHeadCiState.js";
import { deleteExpiredReviewApprovals } from "./intake/reviewApprovals.js";
import { deleteExpiredGithubCapabilities } from "./githubCapabilityRepository.js";

const TERMINAL_STATUSES = ["completed", "failed", "cancelled", "superseded"];

export type RetentionResult = {
  readonly workItemsDeleted: number;
  readonly webhookEventsDeleted: number;
  readonly webhookDuplicatesDeleted: number;
  readonly agentEventsDeleted: number;
  readonly askQuotaBucketsDeleted: number;
  readonly prHeadCiStateDeleted: number;
  readonly reviewApprovalsDeleted: number;
};

/**
 * Delete aged workflow state in independent batches, so a large
 * backlog never holds one long transaction.
 */
export async function runRetention(
  pool: Pool,
  cfg: Pick<Config, "retention" | "agentEvents">,
): Promise<RetentionResult> {
  const [
    workItemsDeleted,
    webhookEventsDeleted,
    webhookDuplicatesDeleted,
    agentEventsDeleted,
    askQuotaBucketsDeleted,
    prHeadCiStateDeleted,
    reviewApprovalsDeleted,
  ] = await Promise.all([
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
          [TERMINAL_STATUSES, cfg.retention.agentWorkSeconds, RETENTION_DELETE_BATCH_SIZE],
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
          [cfg.retention.webhookEventsSeconds, RETENTION_DELETE_BATCH_SIZE],
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
          `DELETE FROM webhook_delivery_duplicates
            WHERE id IN (
              SELECT id FROM webhook_delivery_duplicates
               WHERE received_at < now() - ($1::bigint * interval '1 second')
               LIMIT $2::int
            )`,
          [cfg.retention.webhookEventsSeconds, RETENTION_DELETE_BATCH_SIZE],
        );
        const batch = result.rowCount ?? 0;
        deleted += batch;
        if (batch < RETENTION_DELETE_BATCH_SIZE) break;
      }
      return deleted;
    })(),
    (async () => {
      if (cfg.agentEvents.retentionSeconds <= 0) return 0;
      let deleted = 0;
      for (;;) {
        const result = await pool.query(
          `DELETE FROM agent_events
            WHERE id IN (
              SELECT id FROM agent_events
               WHERE recorded_at < now() - ($1::bigint * interval '1 second')
               LIMIT $2::int
            )`,
          [cfg.agentEvents.retentionSeconds, RETENTION_DELETE_BATCH_SIZE],
        );
        const batch = result.rowCount ?? 0;
        deleted += batch;
        if (batch < RETENTION_DELETE_BATCH_SIZE) break;
      }
      return deleted;
    })(),
    deleteExpiredAskQuotaState(pool, cfg.retention.agentWorkSeconds, RETENTION_DELETE_BATCH_SIZE),
    deleteExpiredPrHeadCiState(pool, cfg.retention.agentWorkSeconds),
    deleteExpiredReviewApprovals(pool, cfg.retention.agentWorkSeconds),
  ]);
  await deleteExpiredGithubCapabilities(pool, cfg.retention.agentWorkSeconds);
  return {
    workItemsDeleted,
    webhookEventsDeleted,
    webhookDuplicatesDeleted,
    agentEventsDeleted,
    askQuotaBucketsDeleted,
    prHeadCiStateDeleted,
    reviewApprovalsDeleted,
  };
}

let warnedAgentEventsRetentionDisabled = false;

export async function ensureRetentionSchedule(
  boss: PgBoss,
  cfg: Pick<Config, "retention" | "agentEvents">,
): Promise<void> {
  if (
    cfg.agentEvents.enabled &&
    cfg.agentEvents.retentionSeconds <= 0 &&
    !warnedAgentEventsRetentionDisabled
  ) {
    warnedAgentEventsRetentionDisabled = true;
    logWarn("agent_events_retention_disabled");
  }
  await boss.createQueue(RETENTION_QUEUE, { policy: "standard" });
  if (cfg.retention.enabled) {
    await boss.schedule(RETENTION_QUEUE, cfg.retention.cron);
  } else {
    await boss.unschedule(RETENTION_QUEUE);
  }
}
