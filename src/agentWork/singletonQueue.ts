import type { PgBoss } from "pg-boss";
import { pgBossDb } from "../db/postgres.js";
import { REVIEW_QUEUE } from "../settings/index.js";
import { reviewSingletonKey } from "./types.js";

export type SingletonSlotDb = ReturnType<typeof pgBossDb>;

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
  },
): Promise<void> {
  const cancelNonTerminal = params.cancelNonTerminal !== false;
  const connection = params.db ? { db: params.db } : undefined;
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
      // key_strict_fifo blocks while failed; delete clears the slot.
      await boss.deleteJob(params.queue, job.id, connection);
      continue;
    }
    if (cancelNonTerminal) {
      await boss.cancel(params.queue, job.id, connection);
    }
  }
}

/** Cancel in-flight review singleton jobs and clear failed blockers. */
export async function releaseReviewSingletonSlot(
  boss: PgBoss,
  resourceKey: string,
  opts?: {
    readonly db?: SingletonSlotDb;
    readonly skipJobId?: string;
    readonly skipWorkItemId?: string;
    readonly cancelNonTerminal?: boolean;
  },
): Promise<void> {
  await releaseSingletonSlot(boss, {
    queue: REVIEW_QUEUE,
    singletonKey: reviewSingletonKey(resourceKey),
    db: opts?.db,
    skipJobId: opts?.skipJobId,
    skipWorkItemId: opts?.skipWorkItemId,
    cancelNonTerminal: opts?.cancelNonTerminal,
  });
}
