import { Effect, Layer } from "effect";
import type { Pool } from "pg";
import type { JobWithMetadata, Job, PgBoss, WorkOptions } from "pg-boss";
import type { Config } from "../config.js";
import { errorLogFields, nonErrorThrown } from "../errors/appError.js";
import { logDebug, logError, logInfo, logWarn, runWithOperationLogger } from "../evlog.js";
import { cleanupStaleLocalPrWorkspaces } from "../prWorkspace/index.js";
import {
  ACK_QUEUE,
  ASK_QUEUE,
  CI_REFRESH_QUEUE,
  CODE_INDEX_BUILD_CONCURRENCY,
  CODE_INDEX_BUILD_QUEUE,
  DESCRIPTION_QUEUE,
  RETENTION_QUEUE,
  RETENTION_QUEUE_POLLING_INTERVAL_SECONDS,
  REVIEW_QUEUE,
  TRIAGE_QUEUE,
  VERIFICATION_QUEUE,
} from "../settings/index.js";
import {
  executeAckJob,
  executeAskJob,
  executeCiRefreshJob,
  executeDescriptionJob,
  executeReviewJob,
  executeTriageJob,
  executeVerificationJob,
} from "./executors/index.js";
import { executeCodeIndexBuildJob, type CodeIndexBuildJobData } from "../codeIndex/buildJob.js";
import {
  type AckJobData,
  type AskJobData,
  type CiRefreshJobData,
  type DescriptionJobData,
  type ReviewJobData,
  type TriageJobData,
  type VerificationJobData,
} from "./types.js";
import { ensureRetentionSchedule, runRetention } from "./retention.js";
import { reapReviewQueueOrphans } from "./reviewQueueSlot.js";
import { reapStrandedWorkItems } from "./strandedWorkReaper.js";
import {
  collectQueueDiagnostics,
  evaluateWorkerReadiness,
  logQueueDiagnosticsReport,
  probeWorkerDependencies,
  QUEUE_DIAGNOSTICS_INTERVAL_MS,
  startPeriodicQueueDiagnostics,
  startWorkerHealthServer,
  WORKER_CONSUMER_QUEUES,
} from "./workerHealth.js";

const AGENT_QUEUE_STATS_QUEUES = [
  ACK_QUEUE,
  REVIEW_QUEUE,
  ASK_QUEUE,
  DESCRIPTION_QUEUE,
  TRIAGE_QUEUE,
  VERIFICATION_QUEUE,
  CI_REFRESH_QUEUE,
] as const;

export type AgentQueueStatsSnapshot = {
  readonly queuedCount?: number;
  readonly activeCount?: number;
  readonly totalCount?: number;
};

export type QueueStatsBoss = {
  getQueueStats(
    name: string,
    options?: Parameters<PgBoss["getQueueStats"]>[1],
  ): Promise<readonly AgentQueueStatsSnapshot[]>;
};

export async function logAgentQueueStats(boss: QueueStatsBoss): Promise<void> {
  const results = await Promise.all(
    AGENT_QUEUE_STATS_QUEUES.map(async (queue) => {
      const [stats] = await boss.getQueueStats(queue);
      return { queue, stats };
    }),
  );
  for (const { queue, stats } of results) {
    logDebug("agent_queue_stats", {
      queue,
      queued: stats?.queuedCount,
      active: stats?.activeCount,
      total: stats?.totalCount,
    });
  }
}

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
): Promise<string> {
  return boss.work<T>(queue, options, async ([job]) => {
    // SAFETY: log metadata only reads optional correlation strings; other queue payloads leave them undefined.
    await runWithOperationLogger(
      workerJobMeta(
        queue,
        job.data as { workItemId?: string; webhookEventId?: string; delivery?: string },
        job.id,
      ),
      () => dispatch(job),
    );
  });
}

type MetadataWorkOptions = WorkOptions & { includeMetadata: true };

function registerMetadataQueue<T>(
  boss: PgBoss,
  queue: string,
  options: Omit<WorkOptions, "includeMetadata">,
  dispatch: (job: JobWithMetadata<T>) => Promise<void>,
): Promise<string> {
  const workOptions = { ...options, includeMetadata: true } satisfies MetadataWorkOptions;
  return boss.work<T>(queue, workOptions, async ([job]) => {
    // SAFETY: log metadata only reads optional correlation strings; other queue payloads leave them undefined.
    await runWithOperationLogger(
      workerJobMeta(
        queue,
        job.data as { workItemId?: string; webhookEventId?: string; delivery?: string },
        job.id,
      ),
      () => {
        // SAFETY: workOptions sets includeMetadata: true, so pg-boss yields JobWithMetadata.
        return dispatch(job as JobWithMetadata<T>);
      },
    );
  });
}

export function retentionQueueWorkOptions(): Parameters<PgBoss["work"]>[1] {
  return {
    localConcurrency: 1,
    pollingIntervalSeconds: RETENTION_QUEUE_POLLING_INTERVAL_SECONDS,
  };
}

/**
 * Stop accepting new jobs without waiting for in-flight handlers.
 * `stopBoss`'s drain timeout bounds how long those handlers may finish.
 */
export type WorkerConsumerBoss = {
  offWork(name: string, options?: Parameters<PgBoss["offWork"]>[1]): ReturnType<PgBoss["offWork"]>;
};

export async function stopWorkerConsumers(boss: WorkerConsumerBoss): Promise<void> {
  await Promise.all([...WORKER_CONSUMER_QUEUES].map((q) => boss.offWork(q, { wait: false })));
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
          const fastQueueOptions = {
            pollingIntervalSeconds: cfg.queuePollingIntervalSeconds,
          };
          const registeredQueues = new Set<string>();
          await ensureRetentionSchedule(boss, cfg);
          await Promise.all([
            registerPlainQueue<AckJobData>(
              boss,
              ACK_QUEUE,
              { localConcurrency: cfg.ackConcurrency, ...fastQueueOptions },
              (job) => executeAckJob(cfg, pool, job.data),
            ).then(() => {
              registeredQueues.add(ACK_QUEUE);
            }),
            registerPlainQueue<CiRefreshJobData>(
              boss,
              CI_REFRESH_QUEUE,
              { localConcurrency: cfg.ackConcurrency, ...fastQueueOptions },
              (job) => executeCiRefreshJob(cfg, pool, job.data),
            ).then(() => {
              registeredQueues.add(CI_REFRESH_QUEUE);
            }),
            registerMetadataQueue<ReviewJobData>(
              boss,
              REVIEW_QUEUE,
              {
                localConcurrency: cfg.reviewConcurrency,
                ...durableQueueOptions,
              },
              (job) => executeReviewJob(cfg, pool, boss, job),
            ).then(() => {
              registeredQueues.add(REVIEW_QUEUE);
            }),
            registerMetadataQueue<AskJobData>(
              boss,
              ASK_QUEUE,
              { localConcurrency: cfg.askConcurrency, ...durableQueueOptions },
              (job) => executeAskJob(cfg, pool, boss, job),
            ).then(() => {
              registeredQueues.add(ASK_QUEUE);
            }),
            registerMetadataQueue<DescriptionJobData>(
              boss,
              DESCRIPTION_QUEUE,
              {
                localConcurrency: cfg.descriptionConcurrency,
                ...durableQueueOptions,
              },
              (job) => executeDescriptionJob(cfg, pool, boss, job),
            ).then(() => {
              registeredQueues.add(DESCRIPTION_QUEUE);
            }),
            registerMetadataQueue<TriageJobData>(
              boss,
              TRIAGE_QUEUE,
              {
                localConcurrency: cfg.triageConcurrency,
                ...durableQueueOptions,
              },
              (job) => executeTriageJob(cfg, pool, boss, job),
            ).then(() => {
              registeredQueues.add(TRIAGE_QUEUE);
            }),
            registerMetadataQueue<VerificationJobData>(
              boss,
              VERIFICATION_QUEUE,
              {
                localConcurrency: cfg.verificationConcurrency,
                ...durableQueueOptions,
              },
              (job) => executeVerificationJob(cfg, pool, boss, job),
            ).then(() => {
              registeredQueues.add(VERIFICATION_QUEUE);
            }),
            registerPlainQueue(boss, RETENTION_QUEUE, retentionQueueWorkOptions(), async () => {
              try {
                const result = await runRetention(pool, cfg);
                logInfo("retention_cleanup", result);
              } catch (e) {
                const err =
                  e instanceof Error
                    ? e
                    : nonErrorThrown("agent_work.retention_cleanup_non_error_thrown");
                logError("retention_cleanup_failed", {
                  message: err.message,
                  ...errorLogFields(err),
                });
                throw err;
              }
            }).then(() => {
              registeredQueues.add(RETENTION_QUEUE);
            }),
            registerPlainQueue<CodeIndexBuildJobData>(
              boss,
              CODE_INDEX_BUILD_QUEUE,
              { localConcurrency: CODE_INDEX_BUILD_CONCURRENCY, ...fastQueueOptions },
              (job) => executeCodeIndexBuildJob(cfg, pool, job.data),
            ).then(() => {
              registeredQueues.add(CODE_INDEX_BUILD_QUEUE);
            }),
          ]);
          logInfo("agent_worker_started", {
            queues: [...WORKER_CONSUMER_QUEUES],
            reviewConcurrency: cfg.reviewConcurrency,
            askConcurrency: cfg.askConcurrency,
            ackConcurrency: cfg.ackConcurrency,
            descriptionConcurrency: cfg.descriptionConcurrency,
            triageConcurrency: cfg.triageConcurrency,
            verificationConcurrency: cfg.verificationConcurrency,
          });

          const runDiagnostics = async (now: Date): Promise<void> => {
            const report = await collectQueueDiagnostics({ boss, pool, now });
            logQueueDiagnosticsReport(report);
            try {
              await cleanupStaleLocalPrWorkspaces();
            } catch (e) {
              const err =
                e instanceof Error
                  ? e
                  : nonErrorThrown("agent_work.workspace_sweep_non_error_thrown");
              logWarn("local_pr_workspace_sweep_failed", {
                message: err.message,
                ...errorLogFields(err),
              });
            }
            try {
              const reaped = await reapStrandedWorkItems(pool);
              if (reaped.reaped > 0) {
                logInfo("stranded_work_reaper_tick", reaped);
              }
            } catch (e) {
              const err =
                e instanceof Error
                  ? e
                  : nonErrorThrown("agent_work.stranded_reaper_non_error_thrown");
              logWarn("stranded_work_reaper_failed", {
                message: err.message,
                ...errorLogFields(err),
              });
            }
            try {
              const orphans = await reapReviewQueueOrphans(boss, pool);
              if (orphans.released > 0 || orphans.staleQueuedLogged > 0) {
                logInfo("review_queue_orphan_reaper_tick", orphans);
              }
            } catch (e) {
              const err =
                e instanceof Error
                  ? e
                  : nonErrorThrown("agent_work.review_queue_reaper_non_error_thrown");
              logWarn("review_queue_orphan_reaper_failed", {
                message: err.message,
                ...errorLogFields(err),
              });
            }
          };
          await runDiagnostics(new Date());

          const diagnostics = startPeriodicQueueDiagnostics({
            intervalMs: QUEUE_DIAGNOSTICS_INTERVAL_MS,
            now: () => new Date(),
            tick: runDiagnostics,
          });

          const health = startWorkerHealthServer({
            port: cfg.port,
            getReadiness: async () => {
              const deps = await probeWorkerDependencies(pool, boss);
              return evaluateWorkerReadiness({
                registeredQueues,
                requiredQueues: WORKER_CONSUMER_QUEUES,
                postgresOk: deps.postgresOk,
                pgBossInstalled: deps.pgBossInstalled,
              });
            },
          });

          return { diagnostics, health };
        },
        catch: (error) =>
          error instanceof Error ? error : nonErrorThrown("agent_work.worker_start_failed"),
      }),
      (handles) =>
        Effect.tryPromise({
          try: async () => {
            handles.diagnostics.stop();
            await handles.health.close().catch(() => undefined);
            await stopWorkerConsumers(boss);
          },
          catch: (error) =>
            error instanceof Error ? error : nonErrorThrown("agent_work.worker_stop_failed"),
        }).pipe(Effect.orDie),
    ).pipe(Effect.zipRight(Effect.never)),
  );
