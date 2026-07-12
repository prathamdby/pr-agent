import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import {
  HEALTH_DB_PING_TIMEOUT_MS,
  QUEUE_STALL_DIAGNOSTIC_QUEUES,
} from "../settings/index.js";

export type WorkerReadinessState = {
  consumersRegistered: boolean;
};

export type WorkerReadinessDeps = {
  readonly pool: Pool;
  readonly boss: PgBoss;
  readonly state: WorkerReadinessState;
  readonly pollStaleSeconds: number;
  readonly nowMs?: () => number;
};

export type WorkerReadinessResult = {
  readonly ready: boolean;
  readonly reason?: string;
};

async function pingPostgres(pool: Pool): Promise<boolean> {
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("postgres ping timed out")), HEALTH_DB_PING_TIMEOUT_MS);
  });
  try {
    await Promise.race([pool.query("SELECT 1"), timeout]);
    return true;
  } catch {
    return false;
  }
}

async function pingBoss(boss: PgBoss): Promise<boolean> {
  try {
    const sampleQueue = QUEUE_STALL_DIAGNOSTIC_QUEUES[0];
    await boss.getQueue(sampleQueue);
    return true;
  } catch {
    return false;
  }
}

function pollingFresh(
  boss: PgBoss,
  pollStaleSeconds: number,
  nowMs: () => number,
): { ok: boolean; reason?: string } {
  const wip = boss.getWipData();
  if (wip.length === 0) {
    return { ok: false, reason: "no_consumers_polling" };
  }
  const active = wip.filter((entry) => entry.state === "active");
  if (active.length === 0) {
    return { ok: false, reason: "consumers_not_active" };
  }
  const now = nowMs();
  const staleMs = pollStaleSeconds * 1000;
  const freshest = Math.max(
    ...active.map((entry) => entry.lastFetchedOn ?? entry.createdOn ?? 0),
  );
  if (freshest <= 0 || now - freshest > staleMs) {
    return { ok: false, reason: "polling_stale" };
  }
  return { ok: true };
}

/**
 * Worker readiness: consumers registered, polling freshness, Postgres + pg-boss access.
 * Empty queues do not affect readiness.
 */
export async function evaluateWorkerReadiness(
  deps: WorkerReadinessDeps,
): Promise<WorkerReadinessResult> {
  if (!deps.state.consumersRegistered) {
    return { ready: false, reason: "consumers_not_registered" };
  }
  const nowMs = deps.nowMs ?? Date.now;
  const poll = pollingFresh(deps.boss, deps.pollStaleSeconds, nowMs);
  if (!poll.ok) {
    return { ready: false, reason: poll.reason };
  }
  if (!(await pingPostgres(deps.pool))) {
    return { ready: false, reason: "postgres_unreachable" };
  }
  if (!(await pingBoss(deps.boss))) {
    return { ready: false, reason: "pg_boss_unreachable" };
  }
  return { ready: true };
}
