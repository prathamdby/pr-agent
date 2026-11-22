import { setImmediate as yieldToIntake } from "node:timers/promises";
import type { DatabaseSync } from "node:sqlite";
import { RETENTION_DELETE_BATCH_SIZE, type Config } from "../settings/index.ts";

const TERMINAL_RUN_STATUSES = ["completed", "failed", "cancelled", "superseded"];
const DELETE_BATCH = RETENTION_DELETE_BATCH_SIZE;

export type RetentionResult = {
  readonly workRunsDeleted: number;
  readonly workRunAttemptsDeleted: number;
  readonly webhookRowsDeleted: number;
  readonly askQuotaRowsDeleted: number;
  readonly prHeadCiStateDeleted: number;
  readonly publishIntentsDeleted: number;
  readonly agentFeedbackDeleted: number;
  readonly reviewApprovalsCleared: number;
  readonly capabilitiesDeleted: number;
};

async function deleteBatch(db: DatabaseSync, sql: string, ...params: readonly (number | string)[]) {
  const statement = db.prepare(sql);
  let total = 0;
  for (;;) {
    const deleted = Number(statement.run(...params).changes);
    total += deleted;
    if (deleted < DELETE_BATCH) return total;
    await yieldToIntake();
  }
}

export async function runRetention(
  db: DatabaseSync,
  cfg: Pick<Config, "retention" | "agentEvents">,
  now: number,
) {
  const webhookCutoff = now - cfg.retention.webhookEventsSeconds * 1000;
  const workCutoff = now - cfg.retention.agentWorkSeconds * 1000;
  const terminalIn = TERMINAL_RUN_STATUSES.map((status) => `'${status}'`).join(", ");

  const workRunsDeleted = await deleteBatch(
    db,
    `DELETE FROM work_runs WHERE work_id IN (
       SELECT work_id FROM work_runs
        WHERE status IN (${terminalIn}) AND updated_at < ?
          AND NOT EXISTS (SELECT 1 FROM publish_intents i WHERE i.work_id = work_runs.work_id
            AND i.state IN ('mutating', 'outcome_unknown_recoverable'))
        LIMIT ${String(DELETE_BATCH)})`,
    workCutoff,
  );
  const workRunAttemptsDeleted = await deleteBatch(
    db,
    `DELETE FROM work_run_attempts WHERE rowid IN (
       SELECT a.rowid FROM work_run_attempts a
        WHERE NOT EXISTS (SELECT 1 FROM work_runs w WHERE w.work_id = a.work_id)
        LIMIT ${String(DELETE_BATCH)})`,
  );
  const webhookRowsDeleted =
    (await deleteBatch(
      db,
      `DELETE FROM webhook_deliveries WHERE rowid IN (
         SELECT rowid FROM webhook_deliveries WHERE created_at < ? LIMIT ${String(DELETE_BATCH)})`,
      webhookCutoff,
    )) +
    (await deleteBatch(
      db,
      `DELETE FROM webhook_body_replays WHERE rowid IN (
         SELECT rowid FROM webhook_body_replays WHERE created_at < ? LIMIT ${String(DELETE_BATCH)})`,
      webhookCutoff,
    )) +
    (await deleteBatch(
      db,
      `DELETE FROM webhook_rejections WHERE id IN (
         SELECT id FROM webhook_rejections WHERE created_at < ? LIMIT ${String(DELETE_BATCH)})`,
      webhookCutoff,
    ));
  const askQuotaRowsDeleted =
    (await deleteBatch(
      db,
      `DELETE FROM ask_quota_reservations WHERE rowid IN (
         SELECT rowid FROM ask_quota_reservations WHERE updated_at < ? LIMIT ${String(DELETE_BATCH)})`,
      workCutoff,
    )) +
    (await deleteBatch(
      db,
      `DELETE FROM ask_quota_execution_receipts WHERE rowid IN (
         SELECT rowid FROM ask_quota_execution_receipts WHERE created_at < ? LIMIT ${String(DELETE_BATCH)})`,
      workCutoff,
    )) +
    (await deleteBatch(
      db,
      `DELETE FROM ask_quota_buckets WHERE rowid IN (
         SELECT rowid FROM ask_quota_buckets
          WHERE updated_at < ? AND provider_tokens_reserved = 0
          LIMIT ${String(DELETE_BATCH)})`,
      workCutoff,
    ));
  const prHeadCiStateDeleted = await deleteBatch(
    db,
    `DELETE FROM pr_head_ci_state WHERE rowid IN (
       SELECT c.rowid FROM pr_head_ci_state c
        WHERE c.updated_at < ?
          AND NOT EXISTS (
            SELECT 1 FROM work_runs w
             WHERE w.status IN ('pending_dispatch', 'retry_scheduled', 'running')
               AND w.payload_json LIKE '%' || c.head_sha || '%')
        LIMIT ${String(DELETE_BATCH)})`,
    workCutoff,
  );
  const publishIntentsDeleted = await deleteBatch(
    db,
    `DELETE FROM publish_intents WHERE intent_key IN (
       SELECT intent_key FROM publish_intents
        WHERE state IN ('reconciled', 'mutation_failed', 'outcome_unknown_terminal')
          AND updated_at < ?
        LIMIT ${String(DELETE_BATCH)})`,
    workCutoff,
  );
  const reviewApprovalsCleared = Number(
    db
      .prepare(
        `UPDATE pr_state SET approval_json = NULL
          WHERE approval_json IS NOT NULL AND updated_at < ?`,
      )
      .run(workCutoff).changes,
  );
  const capabilitiesDeleted = await deleteBatch(
    db,
    `DELETE FROM github_repository_capabilities WHERE rowid IN (
       SELECT g.rowid FROM github_repository_capabilities g
        WHERE g.updated_at < ?
          AND NOT EXISTS (
            SELECT 1 FROM work_runs w WHERE w.pr_key LIKE g.repo_key || '#%')
        LIMIT ${String(DELETE_BATCH)})`,
    workCutoff,
  );
  const agentFeedbackDeleted =
    cfg.agentEvents.retentionSeconds <= 0
      ? 0
      : await deleteBatch(
          db,
          `DELETE FROM agent_feedback WHERE id IN (
             SELECT id FROM agent_feedback WHERE created_at < ? LIMIT ${String(DELETE_BATCH)})`,
          now - cfg.agentEvents.retentionSeconds * 1000,
        );
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  return ((pinnedReturn: RetentionResult) => pinnedReturn)({
    workRunsDeleted,
    workRunAttemptsDeleted,
    webhookRowsDeleted,
    askQuotaRowsDeleted,
    prHeadCiStateDeleted,
    publishIntentsDeleted,
    agentFeedbackDeleted,
    reviewApprovalsCleared,
    capabilitiesDeleted,
  });
}
