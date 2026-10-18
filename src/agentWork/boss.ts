import { PgBoss, type ConstructorOptions, type QueueOptions } from "pg-boss";
import {
  type Config,
  ACK_DEAD_LETTER_QUEUE,
  PG_BOSS_EVENT_LOG_WINDOW_MS,
  ACK_QUEUE,
  ASK_DEAD_LETTER_QUEUE,
  ASK_QUEUE,
  CI_PROJECTION_DEAD_LETTER_QUEUE,
  CI_PROJECTION_QUEUE,
  DESCRIPTION_DEAD_LETTER_QUEUE,
  DESCRIPTION_QUEUE,
  PG_BOSS_POOL_MAX_WEB,
  PG_BOSS_POOL_MAX_WORKER,
  REVIEW_DEAD_LETTER_QUEUE,
  REVIEW_QUEUE,
  TRIAGE_DEAD_LETTER_QUEUE,
  TRIAGE_QUEUE,
  VERIFICATION_DEAD_LETTER_QUEUE,
  VERIFICATION_QUEUE,
} from "../settings/index.ts";
import { logDebug, logWarn, logError } from "../evlog.ts";
import type { QueueConfig } from "./types.ts";
import { leasedWorkQueues } from "./writeFence.ts";
import { errorMessage } from "../errors/errorMessage.ts";

type BossConfig = Pick<Config, "runtime">;

export const AGENT_DEAD_LETTER_QUEUES = [
  ACK_DEAD_LETTER_QUEUE,
  REVIEW_DEAD_LETTER_QUEUE,
  ASK_DEAD_LETTER_QUEUE,
  DESCRIPTION_DEAD_LETTER_QUEUE,
  TRIAGE_DEAD_LETTER_QUEUE,
  VERIFICATION_DEAD_LETTER_QUEUE,
  CI_PROJECTION_DEAD_LETTER_QUEUE,
] as const;

const RETIRED_CI_REFRESH_QUEUE = "agent-work-ci-refresh";
const RETIRED_CI_REFRESH_DEAD_LETTER_QUEUE = "agent-work-ci-refresh-dead";
const RETIRED_CODE_INDEX_BUILD_QUEUE = "code-index-build";

function queueDefaults(cfg: QueueConfig): QueueOptions {
  return {
    retryLimit: cfg.queue.retryLimit,
    retryDelay: cfg.queue.retryDelaySeconds,
    retryBackoff: true,
    retryDelayMax: cfg.queue.retryDelayMaxSeconds,
    expireInSeconds: cfg.queue.expireInSeconds,
    heartbeatSeconds: cfg.queue.heartbeatSeconds,
    retentionSeconds: cfg.queue.retentionSeconds,
    deleteAfterSeconds: cfg.queue.deleteAfterSeconds,
  };
}

export function bossConstructorOptions(cfg: BossConfig): ConstructorOptions {
  const workerOwnsMaintenance = cfg.runtime.role === "worker";
  return {
    connectionString: cfg.runtime.databaseUrl,
    application_name: "pr-agent",
    max: workerOwnsMaintenance ? PG_BOSS_POOL_MAX_WORKER : PG_BOSS_POOL_MAX_WEB,
    schedule: workerOwnsMaintenance,
    supervise: workerOwnsMaintenance,
  };
}

export function createPgBossEventGate(
  windowMs: number,
): (key: string, now?: number) => number | null {
  const windows = new Map<string, { windowStart: number; repeats: number }>();
  return (key, now = Date.now()) => {
    const window = windows.get(key);
    if (window == null || now - window.windowStart >= windowMs) {
      const previousRepeats = window?.repeats ?? 0;
      windows.set(key, { windowStart: now, repeats: 0 });
      return previousRepeats;
    }
    window.repeats += 1;
    return null;
  };
}

function pgBossEventKey(error: { message: string; code?: unknown }): string {
  return typeof error.code === "string" && error.code.length > 0 ? error.code : error.message;
}

export async function createStartedBoss(cfg: BossConfig): Promise<PgBoss> {
  const boss = new PgBoss(bossConstructorOptions(cfg));
  const eventGate = createPgBossEventGate(PG_BOSS_EVENT_LOG_WINDOW_MS);
  boss.on("error", (error) => {
    const suppressedRepeats = eventGate(pgBossEventKey(error));
    if (suppressedRepeats == null) return;
    logError("pg_boss_error", { message: error.message, suppressedRepeats });
  });
  boss.on("warning", (warning) => {
    const suppressedRepeats = eventGate(pgBossEventKey(warning));
    if (suppressedRepeats == null) return;
    logWarn("pg_boss_warning", { message: warning.message, suppressedRepeats });
  });
  await boss.start();
  return boss;
}

export async function ensureAgentQueues(boss: PgBoss, cfg: QueueConfig): Promise<void> {
  const defaults = queueDefaults(cfg);
  const dlq: QueueOptions = {
    retryLimit: 0,
    retryDelay: 0,
    retryBackoff: false,
    deleteAfterSeconds: cfg.queue.deleteAfterSeconds,
    retentionSeconds: cfg.queue.retentionSeconds,
  };
  await Promise.all(AGENT_DEAD_LETTER_QUEUES.map((name) => boss.createQueue(name, dlq)));

  const workQueues = [
    { name: ACK_QUEUE, deadLetter: ACK_DEAD_LETTER_QUEUE },
    { name: REVIEW_QUEUE, deadLetter: REVIEW_DEAD_LETTER_QUEUE },
    { name: ASK_QUEUE, deadLetter: ASK_DEAD_LETTER_QUEUE },
    { name: DESCRIPTION_QUEUE, deadLetter: DESCRIPTION_DEAD_LETTER_QUEUE },
    { name: TRIAGE_QUEUE, deadLetter: TRIAGE_DEAD_LETTER_QUEUE },
    { name: VERIFICATION_QUEUE, deadLetter: VERIFICATION_DEAD_LETTER_QUEUE },
    { name: CI_PROJECTION_QUEUE, deadLetter: CI_PROJECTION_DEAD_LETTER_QUEUE },
  ] as const;
  await Promise.all(
    workQueues.map(({ name, deadLetter }) =>
      boss.createQueue(name, {
        ...defaults,
        policy: "standard",
        deadLetter,
      }),
    ),
  );

  for (const name of leasedWorkQueues()) {
    const queue = await boss.getQueue(name);
    if (queue?.policy !== "standard") {
      logError("agent_queue_policy_mismatch", { queue: name, policy: queue?.policy });
    }
  }

  await retireLeftoverCiRefreshQueues(boss);
  await retireCodeIndexBuildQueue(boss);
}

type RetiredQueueBoss = Pick<PgBoss, "getQueue" | "getQueueStats" | "deleteQueue">;

function retiredQueueLiveCount(
  stats:
    | {
        readonly queuedCount?: number;
        readonly activeCount?: number;
        readonly deferredCount?: number;
      }
    | null
    | undefined,
): number {
  return (stats?.queuedCount ?? 0) + (stats?.activeCount ?? 0) + (stats?.deferredCount ?? 0);
}

export async function retireLeftoverCiRefreshQueues(boss: RetiredQueueBoss): Promise<void> {
  for (const name of [RETIRED_CI_REFRESH_QUEUE, RETIRED_CI_REFRESH_DEAD_LETTER_QUEUE]) {
    try {
      const queue = await boss.getQueue(name);
      if (queue == null) continue;
      const [stats] = await boss.getQueueStats(name);
      const liveCount = retiredQueueLiveCount(stats);
      if (liveCount > 0) {
        logWarn("retired_queue_not_empty", { queue: name, liveCount });
        continue;
      }
      await boss.deleteQueue(name);
      logDebug("retired_queue_deleted", { queue: name });
    } catch (error) {
      logWarn("retired_queue_delete_failed", {
        queue: name,
        message: errorMessage(error),
      });
    }
  }
}

export async function retireCodeIndexBuildQueue(boss: RetiredQueueBoss): Promise<void> {
  const name = RETIRED_CODE_INDEX_BUILD_QUEUE;
  try {
    const queue = await boss.getQueue(name);
    if (queue == null) return;
    const [stats] = await boss.getQueueStats(name);
    await boss.deleteQueue(name);
    logDebug("retired_queue_deleted", { queue: name, droppedCount: retiredQueueLiveCount(stats) });
  } catch (error) {
    logWarn("retired_queue_delete_failed", { queue: name, message: errorMessage(error) });
  }
}

export async function stopBoss(boss: PgBoss, drainTimeoutMs: number): Promise<void> {
  await boss.stop({ close: true, graceful: true, timeout: drainTimeoutMs });
}
