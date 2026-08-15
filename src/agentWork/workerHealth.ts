import { createServer, type Server } from "node:http";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { captureEvent } from "../analytics/index.js";
import { logDebug, logWarn } from "../evlog.js";
import {
  ACK_DEAD_LETTER_QUEUE,
  ACK_QUEUE,
  ASK_DEAD_LETTER_QUEUE,
  ASK_QUEUE,
  CI_REFRESH_DEAD_LETTER_QUEUE,
  CI_REFRESH_QUEUE,
  CODE_INDEX_BUILD_QUEUE,
  DESCRIPTION_DEAD_LETTER_QUEUE,
  DESCRIPTION_QUEUE,
  HEALTH_DB_PING_TIMEOUT_MS,
  RETENTION_QUEUE,
  REVIEW_DEAD_LETTER_QUEUE,
  REVIEW_QUEUE,
  STALE_QUEUED_WORK_BATCH_SIZE,
  STALE_QUEUED_WORK_GRACE_SECONDS,
  TRIAGE_DEAD_LETTER_QUEUE,
  TRIAGE_QUEUE,
  VERIFICATION_DEAD_LETTER_QUEUE,
  VERIFICATION_QUEUE,
} from "../settings/index.js";

/** Queues that must have registered consumers for worker readiness. */
export const WORKER_CONSUMER_QUEUES = [
  ACK_QUEUE,
  CI_REFRESH_QUEUE,
  REVIEW_QUEUE,
  ASK_QUEUE,
  DESCRIPTION_QUEUE,
  TRIAGE_QUEUE,
  VERIFICATION_QUEUE,
  RETENTION_QUEUE,
  CODE_INDEX_BUILD_QUEUE,
] as const;

/** Active work queues included in continuous diagnostics. */
export const WORKER_DIAGNOSTIC_QUEUES = [
  ACK_QUEUE,
  REVIEW_QUEUE,
  ASK_QUEUE,
  DESCRIPTION_QUEUE,
  TRIAGE_QUEUE,
  VERIFICATION_QUEUE,
  CI_REFRESH_QUEUE,
  RETENTION_QUEUE,
  CODE_INDEX_BUILD_QUEUE,
] as const;

export const WORKER_DLQ_QUEUES = [
  ACK_DEAD_LETTER_QUEUE,
  REVIEW_DEAD_LETTER_QUEUE,
  ASK_DEAD_LETTER_QUEUE,
  DESCRIPTION_DEAD_LETTER_QUEUE,
  TRIAGE_DEAD_LETTER_QUEUE,
  VERIFICATION_DEAD_LETTER_QUEUE,
  CI_REFRESH_DEAD_LETTER_QUEUE,
] as const;

/** Default interval for continuous queue/DLQ diagnostics. */
export const QUEUE_DIAGNOSTICS_INTERVAL_MS = 60_000;

export type WorkerReadinessInput = {
  readonly registeredQueues: ReadonlySet<string>;
  readonly requiredQueues?: readonly string[];
  readonly postgresOk: boolean;
  readonly pgBossInstalled: boolean;
};

export type WorkerReadinessSnapshot = {
  readonly ready: boolean;
  readonly reasons: readonly string[];
  readonly missingQueues: readonly string[];
};

export function evaluateWorkerReadiness(input: WorkerReadinessInput): WorkerReadinessSnapshot {
  const required = input.requiredQueues ?? WORKER_CONSUMER_QUEUES;
  const missingQueues = required.filter((queue) => !input.registeredQueues.has(queue));
  const reasons: string[] = [];
  if (!input.postgresOk) reasons.push("postgres_unreachable");
  if (!input.pgBossInstalled) reasons.push("pg_boss_not_installed");
  if (missingQueues.length > 0) reasons.push("consumers_not_registered");
  return {
    ready: reasons.length === 0,
    reasons,
    missingQueues,
  };
}

export async function probeWorkerDependencies(
  pool: Pick<Pool, "query">,
  boss: Pick<PgBoss, "isInstalled">,
  options?: {
    readonly pingTimeoutMs?: number;
    readonly setTimeoutFn?: typeof setTimeout;
    readonly clearTimeoutFn?: typeof clearTimeout;
  },
): Promise<{ readonly postgresOk: boolean; readonly pgBossInstalled: boolean }> {
  const pingTimeoutMs = options?.pingTimeoutMs ?? HEALTH_DB_PING_TIMEOUT_MS;
  const setTimeoutFn = options?.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options?.clearTimeoutFn ?? clearTimeout;

  const postgresOk = await new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeoutFn(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, pingTimeoutMs);
    void pool
      .query("SELECT 1")
      .then(() => {
        if (settled) return;
        settled = true;
        clearTimeoutFn(timer);
        resolve(true);
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        clearTimeoutFn(timer);
        resolve(false);
      });
  });

  let pgBossInstalled = false;
  try {
    pgBossInstalled = await boss.isInstalled();
  } catch {
    pgBossInstalled = false;
  }
  return { postgresOk, pgBossInstalled };
}

export type QueueLaneDiagnostic = {
  readonly queue: string;
  readonly queued: number;
  readonly active: number;
  readonly total: number;
  readonly deferred: number;
  readonly failed: number;
};

export type DeadLetterDiagnostic = {
  readonly queue: string;
  readonly queued: number;
  readonly total: number;
};

export type StaleQueuedWorkItem = {
  readonly workItemId: string;
  readonly resourceKey: string;
  readonly workType: string;
  readonly ageSeconds: number | null;
};

export type QueueDiagnosticsReport = {
  readonly at: string;
  readonly queues: readonly QueueLaneDiagnostic[];
  readonly deadLetters: readonly DeadLetterDiagnostic[];
  readonly oldestRunningWorkItemAgeMs: number | null;
  readonly staleQueuedWorkItems: readonly StaleQueuedWorkItem[];
};

type DiagnosticsBoss = Pick<PgBoss, "getQueueStats">;

async function laneStats(boss: DiagnosticsBoss, queue: string): Promise<QueueLaneDiagnostic> {
  const [stats] = await boss.getQueueStats(queue);
  return {
    queue,
    queued: stats?.queuedCount ?? 0,
    active: stats?.activeCount ?? 0,
    total: stats?.totalCount ?? 0,
    deferred: stats?.deferredCount ?? 0,
    failed: stats?.failedCount ?? 0,
  };
}

export async function collectQueueDiagnostics(params: {
  readonly boss: DiagnosticsBoss;
  readonly pool: Pick<Pool, "query">;
  readonly now: Date;
  readonly diagnosticQueues?: readonly string[];
  readonly dlqQueues?: readonly string[];
}): Promise<QueueDiagnosticsReport> {
  const diagnosticQueues = params.diagnosticQueues ?? WORKER_DIAGNOSTIC_QUEUES;
  const dlqQueues = params.dlqQueues ?? WORKER_DLQ_QUEUES;

  const queues = await Promise.all(diagnosticQueues.map((queue) => laneStats(params.boss, queue)));
  const deadLetters = await Promise.all(
    dlqQueues.map(async (queue) => {
      const lane = await laneStats(params.boss, queue);
      return { queue, queued: lane.queued, total: lane.total };
    }),
  );

  let oldestRunningWorkItemAgeMs: number | null = null;
  let staleQueuedWorkItems: StaleQueuedWorkItem[] = [];
  try {
    const result = await params.pool.query<{ age_ms: string | number | null }>(
      `SELECT EXTRACT(EPOCH FROM ($1::timestamptz - started_at)) * 1000 AS age_ms
         FROM agent_work_items
        WHERE status = 'running' AND started_at IS NOT NULL
        ORDER BY started_at ASC
        LIMIT 1`,
      [params.now.toISOString()],
    );
    const raw = result.rows[0]?.age_ms;
    if (raw != null) {
      const age = typeof raw === "number" ? raw : Number(raw);
      if (Number.isFinite(age)) oldestRunningWorkItemAgeMs = Math.max(0, age);
    }

    // A queued leased-type item with no live lease row has no holder to wait behind
    // and no watchdog chain that can still fire: its delivery chain died.
    const stale = await params.pool.query<{
      id: string;
      resource_key: string;
      work_type: string;
      age_seconds: string | number;
    }>(
      `SELECT w.id::text AS id,
              w.resource_key,
              w.type AS work_type,
              EXTRACT(EPOCH FROM ($1::timestamptz - w.created_at)) AS age_seconds
         FROM agent_work_items w
        WHERE w.type IN ('review', 'description', 'triage', 'verification')
          AND w.status = 'queued'
          AND w.created_at < $1::timestamptz - ($2 * interval '1 second')
          AND NOT EXISTS (
            SELECT 1 FROM pr_actor_leases l
             WHERE l.resource_key = w.resource_key
               AND l.work_type = w.type
               AND l.work_item_id IS NOT NULL
               AND l.expires_at > $1::timestamptz
          )
        ORDER BY w.created_at ASC
        LIMIT $3::int`,
      [params.now.toISOString(), STALE_QUEUED_WORK_GRACE_SECONDS, STALE_QUEUED_WORK_BATCH_SIZE],
    );
    staleQueuedWorkItems = stale.rows.map((row) => {
      const age = typeof row.age_seconds === "number" ? row.age_seconds : Number(row.age_seconds);
      return {
        workItemId: row.id,
        resourceKey: row.resource_key,
        workType: row.work_type,
        ageSeconds: Number.isFinite(age) ? Math.floor(age) : null,
      };
    });
  } catch {
    oldestRunningWorkItemAgeMs = null;
    staleQueuedWorkItems = [];
  }

  return {
    at: params.now.toISOString(),
    queues,
    deadLetters,
    oldestRunningWorkItemAgeMs,
    staleQueuedWorkItems,
  };
}

export function logQueueDiagnosticsReport(report: QueueDiagnosticsReport): void {
  for (const lane of report.queues) {
    logDebug("agent_queue_stats", {
      queue: lane.queue,
      queued: lane.queued,
      active: lane.active,
      total: lane.total,
      deferred: lane.deferred,
      failed: lane.failed,
      at: report.at,
    });
  }
  for (const dlq of report.deadLetters) {
    logDebug("agent_dead_letter_stats", {
      queue: dlq.queue,
      queued: dlq.queued,
      total: dlq.total,
      at: report.at,
    });
  }
  logDebug("agent_work_item_age", {
    oldestRunningWorkItemAgeMs: report.oldestRunningWorkItemAgeMs,
    at: report.at,
  });
  for (const stale of report.staleQueuedWorkItems) {
    logWarn("agent_work_queued_stale", {
      workItemId: stale.workItemId,
      resourceKey: stale.resourceKey,
      workType: stale.workType,
      ageSeconds: stale.ageSeconds,
      graceSeconds: STALE_QUEUED_WORK_GRACE_SECONDS,
    });
    captureEvent({
      distinctId: "server",
      event: "work item queued stale",
      properties: {
        work_item_id: stale.workItemId,
        resource_key: stale.resourceKey,
        work_type: stale.workType,
        age_seconds: stale.ageSeconds,
        grace_seconds: STALE_QUEUED_WORK_GRACE_SECONDS,
      },
    });
  }
}

export function startPeriodicQueueDiagnostics(params: {
  readonly intervalMs: number;
  readonly now: () => Date;
  readonly tick: (now: Date) => Promise<void>;
  readonly setIntervalFn?: typeof setInterval;
  readonly clearIntervalFn?: typeof clearInterval;
}): { readonly stop: () => void } {
  const setIntervalFn = params.setIntervalFn ?? setInterval;
  const clearIntervalFn = params.clearIntervalFn ?? clearInterval;
  let inFlight = false;
  const handle = setIntervalFn(() => {
    if (inFlight) return;
    inFlight = true;
    void params
      .tick(params.now())
      .catch((error) => {
        logWarn("agent_queue_diagnostics_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        inFlight = false;
      });
  }, params.intervalMs);
  return {
    stop: () => {
      clearIntervalFn(handle);
    },
  };
}

export function startWorkerHealthServer(params: {
  readonly port: number;
  readonly getReadiness: () => Promise<WorkerReadinessSnapshot>;
}): {
  readonly server: Server;
  readonly close: () => Promise<void>;
} {
  const server = createServer((req, res) => {
    const path = req.url?.split("?")[0] ?? "/";
    if (req.method === "GET" && path === "/health") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("ok");
      return;
    }
    if (req.method === "GET" && path === "/ready") {
      void params
        .getReadiness()
        .then((snapshot) => {
          res.writeHead(snapshot.ready ? 200 : 503, {
            "content-type": "text/plain; charset=utf-8",
          });
          res.end(snapshot.ready ? "ready" : `not ready: ${snapshot.reasons.join(",")}`);
        })
        .catch((error) => {
          res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
          res.end(`not ready: ${error instanceof Error ? error.message : String(error)}`);
        });
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("");
  });

  server.listen(params.port);

  return {
    server,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
