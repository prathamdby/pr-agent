import type { PgBoss } from "pg-boss";
import { pgBossDb } from "../db/postgres.js";

export type SingletonSlotDb = ReturnType<typeof pgBossDb>;

/**
 * Clears failed key_strict_fifo blockers on any durable queue key, and optionally
 * cancels non-terminal jobs (optionally filtered by work item id).
 * Review slots use {@link releaseReviewQueueSlot} instead (also drops orphans).
 */
export async function releaseSingletonSlot(
  boss: PgBoss,
  params: {
    readonly queue: string;
    readonly singletonKey: string;
    readonly db?: SingletonSlotDb;
    readonly skipJobId?: string;
    readonly skipWorkItemId?: string;
    /** When false, only delete failed jobs. Default true also cancels non-terminal jobs. */
    readonly cancelNonTerminal?: boolean;
    /** When set, only cancel non-terminal jobs for these work item ids. */
    readonly cancelWorkItemIds?: readonly string[];
  },
): Promise<void> {
  const cancelNonTerminal = params.cancelNonTerminal !== false;
  const connection = params.db ? { db: params.db } : undefined;
  const cancelWorkItemIds =
    params.cancelWorkItemIds != null ? new Set(params.cancelWorkItemIds) : null;
  const jobs = await boss.findJobs<{ workItemId?: string }>(params.queue, {
    key: params.singletonKey,
    ...connection,
  });
  for (const job of jobs) {
    if (params.skipJobId && job.id === params.skipJobId) continue;
    if (params.skipWorkItemId && job.data.workItemId === params.skipWorkItemId) continue;
    const state = job.state as string;
    if (state === "cancelled" || state === "completed") continue;
    if (state === "failed") {
      await boss.deleteJob(params.queue, job.id, connection);
      continue;
    }
    if (cancelNonTerminal) {
      if (cancelWorkItemIds != null) {
        const workItemId = job.data.workItemId;
        if (workItemId == null || !cancelWorkItemIds.has(workItemId)) continue;
      }
      await boss.cancel(params.queue, job.id, connection);
    }
  }
}
