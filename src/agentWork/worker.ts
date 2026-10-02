import { createWorkDefinitions } from "./workDefinition.js";
import { Effect, Layer } from "effect";
import type { Pool } from "pg";
import type { JobWithMetadata, Job, PgBoss, WorkOptions } from "pg-boss";
import type { ExecutionTracker } from "./executionTracker.js";
import {
  AgentWorkBoss,
  AgentWorkBossLive,
  AgentWorkExecutions,
  AgentWorkExecutionsLive,
  AgentWorkPool,
  AgentWorkPoolLive,
} from "./runtime.js";
import {
  type Config,
  ACK_QUEUE,
  ASK_QUEUE,
  CI_PROJECTION_QUEUE,
  CODE_INDEX_BUILD_CONCURRENCY,
  CODE_INDEX_BUILD_QUEUE,
  DESCRIPTION_QUEUE,
  RETENTION_QUEUE,
  RETENTION_QUEUE_POLLING_INTERVAL_SECONDS,
  REVIEW_QUEUE,
  STALE_QUEUED_WORK_GRACE_SECONDS,
  TRIAGE_QUEUE,
  VERIFICATION_QUEUE,
} from "../settings/index.js";
import { errorLogFields } from "../errors/appError.js";
import { logDebug, logError, logInfo, logWarn, runWithOperationLogger } from "../evlog.js";
import { cleanupStaleLocalPrWorkspaces } from "../prWorkspace/localPrWorkspace.js";
import { executeAckJob } from "./executors/ackExecutor.js";
import { executeCiProjectionJob } from "./executors/ciProjectionExecutor.js";
import { executeCodeIndexBuildJob, type CodeIndexBuildJobData } from "../codeIndex/buildJob.js";
import { type AckJobData, type CiProjectionJobData } from "./types.js";
import { ensureRetentionSchedule, runRetention } from "./retention.js";
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
import { reconcileLostRunningWork } from "./lostRunningWork.js";
import { scanProjectionRepairPending } from "./projectionRepair.js";
import { errorMessage, toError } from "../errors/errorMessage.js";

const AGENT_QUEUE_STATS_QUEUES = [
  ACK_QUEUE,
  REVIEW_QUEUE,
  ASK_QUEUE,
  DESCRIPTION_QUEUE,
  TRIAGE_QUEUE,
  VERIFICATION_QUEUE,
  CI_PROJECTION_QUEUE,
] as const;

export async function logAgentQueueStats(boss: PgBoss): Promise<void> {
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

type JobCorrelation = { workItemId?: string; webhookEventId?: string; delivery?: string };

function workerJobMeta(queue: string, data: JobCorrelation, pgBossJobId?: string) {
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
  executions: ExecutionTracker,
  queue: string,
  options: Parameters<PgBoss["work"]>[1],
  dispatch: (job: Job<T>) => Promise<void>,
  correlation: (data: T) => JobCorrelation = () => ({}),
): Promise<unknown> {
  return boss.work<T>(queue, options, async ([job]) => {
    await executions.track(() =>
      runWithOperationLogger(workerJobMeta(queue, correlation(job.data), job.id), () =>
        dispatch(job),
      ),
    );
  });
}

type MetadataWorkOptions = WorkOptions & { includeMetadata: true };

function registerMetadataQueue<T extends JobCorrelation>(
  boss: PgBoss,
  executions: ExecutionTracker,
  queue: string,
  options: Omit<WorkOptions, "includeMetadata">,
  dispatch: (job: JobWithMetadata<T>) => Promise<void>,
): Promise<unknown> {
  const workOptions = { ...options, includeMetadata: true } satisfies MetadataWorkOptions;
  return boss.work<T, void, MetadataWorkOptions>(queue, workOptions, async ([job]) => {
    await executions.track(() =>
      runWithOperationLogger(workerJobMeta(queue, job.data, job.id), () =>
        // The inner durable lane covers the work-item outcome, not the logger
        // flush: shutdown gives this dispatch a bounded reserve after the
        // general settle, before the pool may end.
        executions.track(() => dispatch(job), { durable: true }),
      ),
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
export async function stopWorkerConsumers(boss: PgBoss): Promise<void> {
  await Promise.all([...WORKER_CONSUMER_QUEUES].map((q) => boss.offWork(q, { wait: false })));
}

export const AgentWorkerLive = (
  cfg: Config,
  pool: Pool,
  boss: PgBoss,
  executions: ExecutionTracker,
) =>
  Layer.effectDiscard(
    Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const heartbeatRefresh = Math.max(1, Math.floor(cfg.queue.heartbeatSeconds / 2));
          const durableQueueOptions = {
            groupConcurrency: cfg.concurrency.installationGroup,
            heartbeatRefreshSeconds: heartbeatRefresh,
            pollingIntervalSeconds: cfg.queue.pollingIntervalSeconds,
          };
          const fastQueueOptions = {
            pollingIntervalSeconds: cfg.queue.pollingIntervalSeconds,
          };
          const registeredQueues = new Set<string>();
          await ensureRetentionSchedule(boss, cfg);
          await Promise.all([
            registerPlainQueue<AckJobData>(
              boss,
              executions,
              ACK_QUEUE,
              { localConcurrency: cfg.concurrency.ack, ...fastQueueOptions },
              (job) => executeAckJob(cfg, pool, job.data, boss),
              (data) => data,
            ).then(() => {
              registeredQueues.add(ACK_QUEUE);
            }),
            registerPlainQueue<CiProjectionJobData>(
              boss,
              executions,
              CI_PROJECTION_QUEUE,
              { localConcurrency: cfg.concurrency.ack, ...fastQueueOptions },
              (job) => executeCiProjectionJob(cfg, pool, boss, job.data),
              (data) => data,
            ).then(() => {
              registeredQueues.add(CI_PROJECTION_QUEUE);
            }),
            ...Object.values(createWorkDefinitions({ cfg, pool, boss })).map((definition) =>
              registerMetadataQueue(
                boss,
                executions,
                definition.queue,
                { localConcurrency: definition.concurrency, ...durableQueueOptions },
                definition.dispatch,
              ).then(() => {
                registeredQueues.add(definition.queue);
              }),
            ),
            registerPlainQueue(
              boss,
              executions,
              RETENTION_QUEUE,
              retentionQueueWorkOptions(),
              async () => {
                try {
                  const result = await runRetention(pool, cfg);
                  logInfo("retention_cleanup", result);
                } catch (e) {
                  logError("retention_cleanup_failed", {
                    message: errorMessage(e),
                    ...errorLogFields(e),
                  });
                  throw e;
                }
              },
            ).then(() => {
              registeredQueues.add(RETENTION_QUEUE);
            }),
            registerPlainQueue<CodeIndexBuildJobData>(
              boss,
              executions,
              CODE_INDEX_BUILD_QUEUE,
              { localConcurrency: CODE_INDEX_BUILD_CONCURRENCY, ...fastQueueOptions },
              (job) => executeCodeIndexBuildJob(cfg, pool, job.data),
            ).then(() => {
              registeredQueues.add(CODE_INDEX_BUILD_QUEUE);
            }),
          ]);
          logInfo("agent_worker_started", {
            queues: [...WORKER_CONSUMER_QUEUES],
            reviewConcurrency: cfg.concurrency.review,
            askConcurrency: cfg.concurrency.ask,
            ackConcurrency: cfg.concurrency.ack,
            descriptionConcurrency: cfg.concurrency.description,
            triageConcurrency: cfg.concurrency.triage,
            verificationConcurrency: cfg.concurrency.verification,
          });

          const runDiagnostics = async (now: Date): Promise<void> => {
            const report = await collectQueueDiagnostics({
              boss,
              pool,
              now,
              lostRunningMinAgeSeconds:
                cfg.queue.prActorLeaseTtlSeconds + STALE_QUEUED_WORK_GRACE_SECONDS,
            });
            logQueueDiagnosticsReport(report);
            try {
              await reconcileLostRunningWork({
                cfg,
                pool,
                items: report.lostRunningWorkItems,
              });
            } catch (e) {
              logWarn("lost_running_work_sweep_failed", {
                message: errorMessage(e),
                ...errorLogFields(e),
              });
            }
            try {
              await cleanupStaleLocalPrWorkspaces();
            } catch (e) {
              logWarn("local_pr_workspace_sweep_failed", {
                message: errorMessage(e),
                ...errorLogFields(e),
              });
            }
            try {
              const repair = await scanProjectionRepairPending({ boss, pool });
              if (repair.pendingScanned > 0 || repair.enqueued > 0 || repair.unreachable > 0) {
                logDebug("ci_projection_repair_scan", {
                  pendingScanned: repair.pendingScanned,
                  enqueued: repair.enqueued,
                  unreachable: repair.unreachable,
                  skippedNoInstallation: repair.skippedNoInstallation,
                });
              }
            } catch (e) {
              logWarn("ci_projection_repair_scan_failed", {
                message: errorMessage(e),
                ...errorLogFields(e),
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
            port: cfg.runtime.port,
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
        catch: (e) => toError(e),
      }),
      (handles) =>
        Effect.tryPromise({
          try: async () => {
            handles.diagnostics.stop();
            await handles.health.close().catch(() => undefined);
            await stopWorkerConsumers(boss);
          },
          catch: (e) => toError(e),
        }).pipe(Effect.orDie),
    ).pipe(Effect.andThen(Effect.never)),
  );

/**
 * Worker role: full queue consumers for agent work items.
 * Provide Boss, then executions, then Pool so finalizers run
 * worker → boss drain → handler settle → durable reserve + analytics → pool.end.
 * A draining handler can still record its outcome while the Pool is alive.
 */
export const agentWorkWorkerLive = (cfg: Config) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const pool = yield* AgentWorkPool;
      const boss = yield* AgentWorkBoss;
      const executions = yield* AgentWorkExecutions;
      yield* Layer.launch(AgentWorkerLive(cfg, pool, boss, executions));
    }),
  ).pipe(
    Layer.provide(AgentWorkBossLive(cfg, { shutdownAnalytics: false })),
    Layer.provide(AgentWorkExecutionsLive),
    Layer.provide(AgentWorkPoolLive(cfg)),
  );
