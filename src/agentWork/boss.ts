import { PgBoss, type ConstructorOptions, type QueueOptions } from "pg-boss";
import type { Config } from "../config.js";
import { logWarn, logError } from "../evlog.js";
import {
  ACK_DEAD_LETTER_QUEUE,
  ACK_QUEUE,
  ASK_DEAD_LETTER_QUEUE,
  ASK_QUEUE,
  DESCRIPTION_DEAD_LETTER_QUEUE,
  DESCRIPTION_QUEUE,
  REVIEW_DEAD_LETTER_QUEUE,
  REVIEW_QUEUE,
  THREAD_REPLY_CLASSIFY_DEAD_LETTER_QUEUE,
  THREAD_REPLY_CLASSIFY_QUEUE,
  TRIAGE_DEAD_LETTER_QUEUE,
  TRIAGE_QUEUE,
  VERIFICATION_DEAD_LETTER_QUEUE,
  VERIFICATION_QUEUE,
} from "../settings/index.js";
import type { QueueConfig } from "./types.js";

type BossConfig = Pick<Config, "databaseUrl" | "role">;

function queueDefaults(cfg: QueueConfig): QueueOptions {
  return {
    retryLimit: cfg.queueRetryLimit,
    retryDelay: cfg.queueRetryDelaySeconds,
    retryBackoff: true,
    retryDelayMax: cfg.queueRetryDelayMaxSeconds,
    expireInSeconds: cfg.queueExpireInSeconds,
    heartbeatSeconds: cfg.queueHeartbeatSeconds,
    retentionSeconds: cfg.queueRetentionSeconds,
    deleteAfterSeconds: cfg.queueDeleteAfterSeconds,
  };
}

export function bossConstructorOptions(cfg: BossConfig): ConstructorOptions {
  const workerOwnsMaintenance = cfg.role === "worker";
  return {
    connectionString: cfg.databaseUrl,
    application_name: "pr-agent",
    schedule: workerOwnsMaintenance,
    supervise: workerOwnsMaintenance,
  };
}

export async function createStartedBoss(cfg: BossConfig): Promise<PgBoss> {
  const boss = new PgBoss(bossConstructorOptions(cfg));
  boss.on("error", (error) => logError("pg_boss_error", { message: error.message }));
  boss.on("warning", (warning) => logWarn("pg_boss_warning", { message: warning.message }));
  await boss.start();
  return boss;
}

const deadLetterQueueOptions = (cfg: QueueConfig): QueueOptions => ({
  retryLimit: 0,
  retryDelay: 0,
  retryBackoff: false,
  deleteAfterSeconds: cfg.queueDeleteAfterSeconds,
  retentionSeconds: cfg.queueRetentionSeconds,
});

export async function ensureAgentQueues(boss: PgBoss, cfg: QueueConfig): Promise<void> {
  const defaults = queueDefaults(cfg);
  const dlq = deadLetterQueueOptions(cfg);
  // DLQ rows are archival only; no workers subscribe to these queue names.
  await boss.createQueue(ACK_DEAD_LETTER_QUEUE, dlq);
  await boss.createQueue(REVIEW_DEAD_LETTER_QUEUE, dlq);
  await boss.createQueue(ASK_DEAD_LETTER_QUEUE, dlq);
  await boss.createQueue(DESCRIPTION_DEAD_LETTER_QUEUE, dlq);
  await boss.createQueue(TRIAGE_DEAD_LETTER_QUEUE, dlq);
  await boss.createQueue(VERIFICATION_DEAD_LETTER_QUEUE, dlq);
  await boss.createQueue(THREAD_REPLY_CLASSIFY_DEAD_LETTER_QUEUE, dlq);
  await boss.createQueue(ACK_QUEUE, {
    ...defaults,
    policy: "standard",
    deadLetter: ACK_DEAD_LETTER_QUEUE,
  });
  await boss.createQueue(REVIEW_QUEUE, {
    ...defaults,
    policy: "key_strict_fifo",
    deadLetter: REVIEW_DEAD_LETTER_QUEUE,
  });
  await boss.createQueue(ASK_QUEUE, {
    ...defaults,
    policy: "standard",
    deadLetter: ASK_DEAD_LETTER_QUEUE,
  });
  await boss.createQueue(DESCRIPTION_QUEUE, {
    ...defaults,
    policy: "key_strict_fifo",
    deadLetter: DESCRIPTION_DEAD_LETTER_QUEUE,
  });
  await boss.createQueue(TRIAGE_QUEUE, {
    ...defaults,
    policy: "key_strict_fifo",
    deadLetter: TRIAGE_DEAD_LETTER_QUEUE,
  });
  await boss.createQueue(VERIFICATION_QUEUE, {
    ...defaults,
    policy: "key_strict_fifo",
    deadLetter: VERIFICATION_DEAD_LETTER_QUEUE,
  });
  await boss.createQueue(THREAD_REPLY_CLASSIFY_QUEUE, {
    ...defaults,
    policy: "standard",
    deadLetter: THREAD_REPLY_CLASSIFY_DEAD_LETTER_QUEUE,
  });
}

export async function stopBoss(boss: PgBoss, drainTimeoutMs: number): Promise<void> {
  await boss.stop({ close: true, graceful: true, timeout: drainTimeoutMs });
}
