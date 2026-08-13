import { createServer, type Server } from "node:http";
import type { PgBoss } from "pg-boss";
import * as v from "valibot";
import { logDebug, logWarn } from "../evlog.js";
import type { IntakeClient } from "../db/postgres.js";
import { isJsonNumber, isJsonString, jsonValueSchema } from "../util/jsonValue.js";
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

/** Default interval for continuous queue/DLQ/blocked-key diagnostics. */
export const QUEUE_DIAGNOSTICS_INTERVAL_MS = 60_000;

/** Timer handles accepted by injected clock fakes (Node Timeout or numeric ids). */
export type InjectedTimerHandle = ReturnType<typeof setTimeout> | number;
export type InjectedSetTimeout = (callback: () => void, delayMs?: number) => InjectedTimerHandle;
export type InjectedClearTimeout = (handle: InjectedTimerHandle) => void;
export type InjectedSetInterval = (callback: () => void, delayMs?: number) => InjectedTimerHandle;
export type InjectedClearInterval = (handle: InjectedTimerHandle) => void;

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
  pool: IntakeClient,
  boss: Pick<PgBoss, "isInstalled">,
  options?: {
    readonly pingTimeoutMs?: number;
    readonly setTimeoutFn?: InjectedSetTimeout;
    readonly clearTimeoutFn?: InjectedClearTimeout;
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

export type BlockedKeyDiagnostic = {
  readonly key: string;
  readonly ageMs: number | null;
};

export type QueueDiagnosticsReport = {
  readonly at: string;
  readonly queues: readonly QueueLaneDiagnostic[];
  readonly deadLetters: readonly DeadLetterDiagnostic[];
  readonly blockedReviewKeys: readonly BlockedKeyDiagnostic[];
  readonly oldestRunningWorkItemAgeMs: number | null;
};

export type QueueStatsSnapshot = {
  readonly name: string;
  readonly deferredCount: number;
  readonly queuedCount: number;
  readonly readyCount: number;
  readonly activeCount: number;
  readonly failedCount: number;
  readonly totalCount: number;
  readonly capturedOn: Date;
};

export type DiagnosticsBoss = {
  getQueueStats(queue: string): Promise<readonly QueueStatsSnapshot[]>;
  getBlockedKeys(queue: string): Promise<readonly string[]>;
  findJobs(
    queue: string,
    options: { readonly key: string },
  ): Promise<readonly { readonly createdOn?: Date }[]>;
};

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

async function blockedKeyAgeMs(
  boss: DiagnosticsBoss,
  key: string,
  nowMs: number,
): Promise<number | null> {
  try {
    const jobs = await boss.findJobs(REVIEW_QUEUE, { key });
    const createdTimes = jobs
      .map((job) => job.createdOn?.getTime?.() ?? Number.NaN)
      .filter((value) => Number.isFinite(value));
    if (createdTimes.length === 0) return null;
    const oldest = Math.min(...createdTimes);
    return Math.max(0, nowMs - oldest);
  } catch {
    return null;
  }
}

export async function collectQueueDiagnostics(params: {
  readonly boss: DiagnosticsBoss;
  readonly pool: IntakeClient;
  readonly now: Date;
  readonly diagnosticQueues?: readonly string[];
  readonly dlqQueues?: readonly string[];
}): Promise<QueueDiagnosticsReport> {
  const diagnosticQueues = params.diagnosticQueues ?? WORKER_DIAGNOSTIC_QUEUES;
  const dlqQueues = params.dlqQueues ?? WORKER_DLQ_QUEUES;
  const nowMs = params.now.getTime();

  const queues = await Promise.all(diagnosticQueues.map((queue) => laneStats(params.boss, queue)));
  const deadLetters = await Promise.all(
    dlqQueues.map(async (queue) => {
      const lane = await laneStats(params.boss, queue);
      return { queue, queued: lane.queued, total: lane.total };
    }),
  );

  const blockedKeys = await params.boss.getBlockedKeys(REVIEW_QUEUE);
  const blockedReviewKeys = await Promise.all(
    blockedKeys.map(async (key) => ({
      key,
      ageMs: await blockedKeyAgeMs(params.boss, key, nowMs),
    })),
  );

  let oldestRunningWorkItemAgeMs: number | null = null;
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
      const ageValue = v.parse(jsonValueSchema, raw);
      const age = isJsonNumber(ageValue)
        ? ageValue
        : isJsonString(ageValue)
          ? Number(ageValue)
          : NaN;
      if (Number.isFinite(age)) oldestRunningWorkItemAgeMs = Math.max(0, age);
    }
  } catch {
    oldestRunningWorkItemAgeMs = null;
  }

  return {
    at: params.now.toISOString(),
    queues,
    deadLetters,
    blockedReviewKeys,
    oldestRunningWorkItemAgeMs,
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
  if (report.blockedReviewKeys.length > 0) {
    logWarn("agent_review_queue_blocked_keys", {
      keys: report.blockedReviewKeys.map((entry) => entry.key),
      agesMs: report.blockedReviewKeys.map((entry) => entry.ageMs),
      at: report.at,
    });
  }
  logDebug("agent_work_item_age", {
    oldestRunningWorkItemAgeMs: report.oldestRunningWorkItemAgeMs,
    at: report.at,
  });
}

export type PeriodicQueueDiagnosticsHandle = {
  readonly stop: () => void;
};

export function startPeriodicQueueDiagnostics(params: {
  readonly intervalMs: number;
  readonly now: () => Date;
  readonly tick: (now: Date) => Promise<void>;
  readonly setIntervalFn?: InjectedSetInterval;
  readonly clearIntervalFn?: InjectedClearInterval;
}): PeriodicQueueDiagnosticsHandle {
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

export type WorkerHealthServerHandle = {
  readonly server: Server;
  readonly close: () => Promise<void>;
};

export function startWorkerHealthServer(params: {
  readonly port: number;
  readonly getReadiness: () => Promise<WorkerReadinessSnapshot>;
}): WorkerHealthServerHandle {
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
