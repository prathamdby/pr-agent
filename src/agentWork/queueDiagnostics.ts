import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import {
  QUEUE_STALL_BLOCKED_KEY_QUEUES,
  QUEUE_STALL_DIAGNOSTIC_DEAD_LETTER_QUEUES,
  QUEUE_STALL_DIAGNOSTIC_QUEUES,
} from "../settings/index.js";

export type QueueDepthStat = {
  readonly queue: string;
  readonly queued: number;
  readonly active: number;
  readonly total: number;
  readonly failed: number;
  readonly oldestQueuedAgeSeconds: number | null;
};

export type BlockedKeyStat = {
  readonly queue: string;
  readonly key: string;
  readonly ageSeconds: number | null;
};

export type ActiveWorkAgeStat = {
  readonly type: string;
  readonly ageSeconds: number;
};

export type QueueStallDiagnostic = {
  readonly queues: readonly QueueDepthStat[];
  readonly deadLetters: readonly QueueDepthStat[];
  readonly blockedKeys: readonly BlockedKeyStat[];
  readonly oldestRunningWork: readonly ActiveWorkAgeStat[];
  /** Explicit: empty queues are not treated as healthy by themselves. */
  readonly emptyQueuesDoNotImplyHealthy: true;
};

export type QueueDiagnosticsDeps = {
  readonly boss: PgBoss;
  readonly pool: Pool;
  readonly nowMs?: () => number;
};

function ageSecondsFrom(date: Date | null | undefined, nowMs: number): number | null {
  if (!date) return null;
  return Math.max(0, Math.floor((nowMs - date.getTime()) / 1000));
}

async function oldestQueuedAgeSeconds(pool: Pool, queue: string): Promise<number | null> {
  try {
    const { rows } = await pool.query<{ age_seconds: string | number | null }>(
      `SELECT EXTRACT(EPOCH FROM (now() - MIN(created_on)))::int AS age_seconds
       FROM pgboss.job
       WHERE name = $1 AND state IN ('created', 'retry')`,
      [queue],
    );
    const age = rows[0]?.age_seconds;
    return age == null ? null : Number(age);
  } catch {
    return null;
  }
}

async function queueDepthStat(
  boss: PgBoss,
  pool: Pool,
  queue: string,
): Promise<QueueDepthStat | null> {
  const stats = await boss.getQueue(queue);
  if (!stats) return null;
  return {
    queue,
    queued: stats.queuedCount,
    active: stats.activeCount,
    total: stats.totalCount,
    failed: stats.failedCount,
    oldestQueuedAgeSeconds:
      stats.queuedCount > 0 ? await oldestQueuedAgeSeconds(pool, queue) : null,
  };
}

async function blockedKeyStats(
  boss: PgBoss,
  queue: string,
  nowMs: number,
): Promise<BlockedKeyStat[]> {
  let keys: string[] = [];
  try {
    keys = await boss.getBlockedKeys(queue);
  } catch {
    return [];
  }
  const out: BlockedKeyStat[] = [];
  for (const key of keys) {
    try {
      const jobs = await boss.findJobs(queue, { key });
      const ages = jobs
        .filter((job) => job.state === "failed" || job.blocked)
        .map((job) => ageSecondsFrom(job.createdOn, nowMs))
        .filter((age): age is number => age != null);
      out.push({
        queue,
        key,
        ageSeconds: ages.length > 0 ? Math.max(...ages) : null,
      });
    } catch {
      out.push({ queue, key, ageSeconds: null });
    }
  }
  return out;
}

async function oldestRunningWork(pool: Pool): Promise<ActiveWorkAgeStat[]> {
  const { rows } = await pool.query<{ type: string; age_seconds: string | number }>(
    `SELECT type,
            EXTRACT(EPOCH FROM (now() - MIN(updated_at)))::int AS age_seconds
     FROM agent_work_items
     WHERE status = 'running'
     GROUP BY type
     ORDER BY age_seconds DESC`,
  );
  return rows.map((row) => ({
    type: row.type,
    ageSeconds: Number(row.age_seconds),
  }));
}

/** Collect continuous queue-stall signals (depth/age, DLQ, blocked keys, oldest active work). */
export async function collectQueueStallDiagnostic(
  deps: QueueDiagnosticsDeps,
): Promise<QueueStallDiagnostic> {
  const nowMs = (deps.nowMs ?? Date.now)();
  const queues: QueueDepthStat[] = [];
  for (const queue of QUEUE_STALL_DIAGNOSTIC_QUEUES) {
    const stat = await queueDepthStat(deps.boss, deps.pool, queue);
    if (stat) queues.push(stat);
  }
  const deadLetters: QueueDepthStat[] = [];
  for (const queue of QUEUE_STALL_DIAGNOSTIC_DEAD_LETTER_QUEUES) {
    const stat = await queueDepthStat(deps.boss, deps.pool, queue);
    if (stat) deadLetters.push(stat);
  }
  const blockedKeys: BlockedKeyStat[] = [];
  for (const queue of QUEUE_STALL_BLOCKED_KEY_QUEUES) {
    blockedKeys.push(...(await blockedKeyStats(deps.boss, queue, nowMs)));
  }
  let oldestRunning: ActiveWorkAgeStat[] = [];
  try {
    oldestRunning = await oldestRunningWork(deps.pool);
  } catch {
    oldestRunning = [];
  }
  return {
    queues,
    deadLetters,
    blockedKeys,
    oldestRunningWork: oldestRunning,
    emptyQueuesDoNotImplyHealthy: true,
  };
}

export function formatQueueStallLogFields(diagnostic: QueueStallDiagnostic) {
  const deadLetterTotal = diagnostic.deadLetters.reduce((sum, q) => sum + q.total, 0);
  return {
    queues: diagnostic.queues,
    dead_letters: diagnostic.deadLetters,
    blocked_keys: diagnostic.blockedKeys,
    oldest_running_work: diagnostic.oldestRunningWork,
    empty_queues_do_not_imply_healthy: diagnostic.emptyQueuesDoNotImplyHealthy,
    dead_letter_total: deadLetterTotal,
    blocked_key_count: diagnostic.blockedKeys.length,
  };
}
