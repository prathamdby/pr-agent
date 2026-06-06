import { Effect, Layer } from "effect";
import type { Pool } from "pg";
import type { JobWithMetadata, Job, PgBoss } from "pg-boss";
import type { Config } from "../config.js";
import { logDebug, logError, logInfo, logWarn, runWithOperationLogger } from "../evlog.js";
import { cleanupStaleLocalPrWorkspaces } from "../prWorkspace/index.js";
import {
  ACK_QUEUE,
  ASK_QUEUE,
  DESCRIPTION_QUEUE,
  RETENTION_QUEUE,
  REVIEW_QUEUE,
} from "../settings/index.js";
import {
  executeAckJob,
  executeAskJob,
  executeDescriptionJob,
  executeReviewJob,
} from "./executors/index.js";
import {
  type AckJobData,
  type AskJobData,
  type DescriptionJobData,
  type ReviewJobData,
} from "./types.js";
import { ensureRetentionSchedule, runRetention } from "./retention.js";

function workerJobMeta(
  queue: string,
  data: { workItemId?: string; webhookEventId?: string; delivery?: string },
  pgBossJobId?: string,
) {
  return {
    method: "JOB",
    path: `/queues/${queue}`,
    requestId: data.delivery ?? data.workItemId ?? pgBossJobId,
    context: {
      role: "worker",
      queue,
      workItemId: data.workItemId,
      webhookEventId: data.webhookEventId,
      delivery: data.delivery,
      pgBossJobId,
    },
  };
}

function registerPlainQueue<T>(
  boss: PgBoss,
  queue: string,
  options: Parameters<PgBoss["work"]>[1],
  dispatch: (job: Job<T>) => Promise<void>,
): Promise<unknown> {
  return boss.work<T>(queue, options, async ([job]) => {
    await runWithOperationLogger(workerJobMeta(queue, job.data as never, job.id), () =>
      dispatch(job),
    );
  });
}

function registerMetadataQueue<T>(
  boss: PgBoss,
  queue: string,
  options: Omit<Parameters<PgBoss["work"]>[1], "includeMetadata">,
  dispatch: (job: JobWithMetadata<T>) => Promise<void>,
): Promise<unknown> {
  return boss.work<T>(queue, { ...options, includeMetadata: true }, async ([job]) => {
    await runWithOperationLogger(workerJobMeta(queue, job.data as never, job.id), () =>
      dispatch(job),
    );
  });
}

export const AgentWorkerLive = (cfg: Config, pool: Pool, boss: PgBoss) =>
  Layer.scopedDiscard(
    Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const heartbeatRefresh = Math.max(1, Math.floor(cfg.queueHeartbeatSeconds / 2));
          const durableQueueOptions = {
            groupConcurrency: cfg.installationGroupConcurrency,
            heartbeatRefreshSeconds: heartbeatRefresh,
            pollingIntervalSeconds: cfg.queuePollingIntervalSeconds,
          };
          const fastQueueOptions = { pollingIntervalSeconds: cfg.queuePollingIntervalSeconds };
          await cleanupStaleLocalPrWorkspaces(cfg);
          await ensureRetentionSchedule(boss, cfg);
          await Promise.all([
            registerPlainQueue<AckJobData>(
              boss,
              ACK_QUEUE,
              { localConcurrency: cfg.ackConcurrency, ...fastQueueOptions },
              (job) => executeAckJob(cfg, pool, job.data),
            ),
            registerMetadataQueue<ReviewJobData>(
              boss,
              REVIEW_QUEUE,
              { localConcurrency: cfg.reviewConcurrency, ...durableQueueOptions },
              (job) => executeReviewJob(cfg, pool, boss, job),
            ),
            registerMetadataQueue<AskJobData>(
              boss,
              ASK_QUEUE,
              { localConcurrency: cfg.askConcurrency, ...durableQueueOptions },
              (job) => executeAskJob(cfg, pool, boss, job),
            ),
            registerMetadataQueue<DescriptionJobData>(
              boss,
              DESCRIPTION_QUEUE,
              { localConcurrency: cfg.descriptionConcurrency, ...durableQueueOptions },
              (job) => executeDescriptionJob(cfg, pool, boss, job),
            ),
            registerPlainQueue(
              boss,
              RETENTION_QUEUE,
              { localConcurrency: 1, ...fastQueueOptions },
              async () => {
                try {
                  const result = await runRetention(pool, cfg);
                  logInfo("retention_cleanup", result);
                } catch (e) {
                  logError("retention_cleanup_failed", {
                    message: e instanceof Error ? e.message : String(e),
                  });
                  throw e;
                }
              },
            ),
          ]);
          logInfo("agent_worker_started", {
            queues: [ACK_QUEUE, REVIEW_QUEUE, ASK_QUEUE, DESCRIPTION_QUEUE, RETENTION_QUEUE],
            reviewConcurrency: cfg.reviewConcurrency,
            askConcurrency: cfg.askConcurrency,
            ackConcurrency: cfg.ackConcurrency,
            descriptionConcurrency: cfg.descriptionConcurrency,
          });
          for (const queue of [ACK_QUEUE, REVIEW_QUEUE, ASK_QUEUE, DESCRIPTION_QUEUE]) {
            const stats = await boss.getQueueStats(queue);
            logDebug("agent_queue_stats", {
              queue,
              queued: stats.queuedCount,
              active: stats.activeCount,
              total: stats.totalCount,
            });
          }
          const blockedReviewKeys = await boss.getBlockedKeys(REVIEW_QUEUE);
          if (blockedReviewKeys.length > 0) {
            logWarn("agent_review_queue_blocked_keys", { keys: blockedReviewKeys });
          }
        },
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }),
      () =>
        Effect.tryPromise({
          try: async () => {
            await Promise.all(
              [ACK_QUEUE, REVIEW_QUEUE, ASK_QUEUE, DESCRIPTION_QUEUE, RETENTION_QUEUE].map((q) =>
                boss.offWork(q),
              ),
            );
          },
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }).pipe(Effect.orDie),
    ).pipe(Effect.zipRight(Effect.never)),
  );
