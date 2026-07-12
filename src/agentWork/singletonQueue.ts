import type { PgBoss } from "pg-boss";
import type { PoolClient } from "pg";
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
  },
): Promise<void> {
  const jobs = await boss.findJobs(params.queue, {
    key: params.singletonKey,
    ...(params.db ? { db: params.db } : {}),
  });
  for (const job of jobs) {
    if (params.skipJobId && job.id === params.skipJobId) continue;
    const state = job.state as string;
    if (state === "cancelled" || state === "completed" || state === "failed") continue;
    await boss.cancel(params.queue, job.id, params.db ? { db: params.db } : undefined);
  }
}

/** Cancel in-flight pg-boss jobs for a review lens singleton (no transaction db). */
export async function releaseReviewSingletonSlot(
  boss: PgBoss,
  resourceKey: string,
  opts?: { readonly skipJobId?: string },
): Promise<void> {
  const legacySingletonKeys = [
    `${resourceKey}:review-security`,
    `${resourceKey}:review-quality`,
    `${resourceKey}:review-tests`,
  ] as const;
  for (const singletonKey of [reviewSingletonKey(resourceKey), ...legacySingletonKeys]) {
    await releaseSingletonSlot(boss, {
      queue: REVIEW_QUEUE,
      singletonKey,
      skipJobId: opts?.skipJobId,
    });
  }
}

export function reviewSingletonSlotDb(client: PoolClient): SingletonSlotDb {
  return pgBossDb(client);
}
