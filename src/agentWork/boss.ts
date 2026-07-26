import { PgBoss, type ConstructorOptions, type QueueOptions } from "pg-boss";
import type { Config } from "../config.js";
import { logWarn, logError } from "../evlog.js";
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
  REVIEW_DEAD_LETTER_QUEUE,
  REVIEW_QUEUE,
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

export async function ensureAgentQueues(boss: PgBoss, cfg: QueueConfig): Promise<void> {
  const defaults = queueDefaults(cfg);
  const dlq: QueueOptions = {
    retryLimit: 0,
    retryDelay: 0,
    retryBackoff: false,
    deleteAfterSeconds: cfg.queueDeleteAfterSeconds,
    retentionSeconds: cfg.queueRetentionSeconds,
  };
  // DLQ rows are archival only; no workers subscribe to these queue names.
  const deadLetterQueues = [
    ACK_DEAD_LETTER_QUEUE,
    REVIEW_DEAD_LETTER_QUEUE,
    ASK_DEAD_LETTER_QUEUE,
    DESCRIPTION_DEAD_LETTER_QUEUE,
    TRIAGE_DEAD_LETTER_QUEUE,
    VERIFICATION_DEAD_LETTER_QUEUE,
    CI_REFRESH_DEAD_LETTER_QUEUE,
  ] as const;
  await Promise.all(deadLetterQueues.map((name) => boss.createQueue(name, dlq)));

  const workQueues = [
    { name: ACK_QUEUE, policy: "standard" as const, deadLetter: ACK_DEAD_LETTER_QUEUE },
    {
      name: REVIEW_QUEUE,
      policy: "key_strict_fifo" as const,
      deadLetter: REVIEW_DEAD_LETTER_QUEUE,
    },
    { name: ASK_QUEUE, policy: "standard" as const, deadLetter: ASK_DEAD_LETTER_QUEUE },
    {
      name: DESCRIPTION_QUEUE,
      policy: "key_strict_fifo" as const,
      deadLetter: DESCRIPTION_DEAD_LETTER_QUEUE,
    },
    {
      name: TRIAGE_QUEUE,
      policy: "key_strict_fifo" as const,
      deadLetter: TRIAGE_DEAD_LETTER_QUEUE,
    },
    {
      name: VERIFICATION_QUEUE,
      policy: "key_strict_fifo" as const,
      deadLetter: VERIFICATION_DEAD_LETTER_QUEUE,
    },
    {
      name: CI_REFRESH_QUEUE,
      policy: "standard" as const,
      deadLetter: CI_REFRESH_DEAD_LETTER_QUEUE,
    },
  ] as const;
  await Promise.all(
    workQueues.map(({ name, policy, deadLetter }) =>
      boss.createQueue(name, {
        ...defaults,
        policy,
        deadLetter,
      }),
    ),
  );

  // No DLQ; created at boot so work()/diagnostics never hit a missing queue.
  await boss.createQueue(CODE_INDEX_BUILD_QUEUE, {
    ...defaults,
    policy: "standard",
  });
}

export async function stopBoss(boss: PgBoss, drainTimeoutMs: number): Promise<void> {
  await boss.stop({ close: true, graceful: true, timeout: drainTimeoutMs });
}
