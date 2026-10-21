import { Context, Effect, Layer } from "effect";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { type Config, SHUTDOWN_SETTLE_TIMEOUT_MS } from "../settings/index.ts";
import { runMigrations } from "../db/migrations.ts";
import { createPgPool } from "../db/postgres.ts";
import { retryTransientConnect } from "../db/transientConnect.ts";
import { shutdownAnalytics } from "../analytics/index.ts";
import { initTraces } from "../traces/recorder.ts";
import { logWarn } from "../evlog.ts";
import { createStartedBoss, ensureAgentQueues, stopBoss } from "./boss.ts";
import { createExecutionTracker, type ExecutionTracker } from "./executionTracker.ts";
import { AgentWorkScheduler, makeAgentWorkScheduler } from "./scheduler.ts";
import { toError } from "../errors/errorMessage.ts";

export class AgentWorkPool extends Context.Service<AgentWorkPool, Pool>()("AgentWorkPool") {}
export class AgentWorkBoss extends Context.Service<AgentWorkBoss, PgBoss>()("AgentWorkBoss") {}
export class AgentWorkExecutions extends Context.Service<AgentWorkExecutions, ExecutionTracker>()(
  "AgentWorkExecutions",
) {}

function openWorkerTraces(cfg: Config): () => Promise<void> {
  return initTraces(cfg);
}

export const AgentWorkExecutionsLive = (cfg: Config) =>
  Layer.effect(
    AgentWorkExecutions,
    Effect.acquireRelease(
      Effect.sync(() => ({
        tracker: createExecutionTracker(),
        closeTraces: openWorkerTraces(cfg),
      })),
      ({ tracker, closeTraces }) =>
        Effect.promise(async () => {
          const outcomes: PromiseSettledResult<unknown>[] = await Promise.allSettled([
            tracker.settle(SHUTDOWN_SETTLE_TIMEOUT_MS),
          ]);
          outcomes.push(
            ...(await Promise.allSettled([
              tracker.settle(SHUTDOWN_SETTLE_TIMEOUT_MS, { durableOnly: true }),
              shutdownAnalytics(),
              closeTraces(),
            ])),
          );
          const remaining = await tracker.settle(0);
          if (remaining.pendingHandlers > 0 || remaining.pendingDurable > 0) {
            logWarn("agent_worker_shutdown_incomplete", {
              pendingHandlers: remaining.pendingHandlers,
              pendingDurableDispatches: remaining.pendingDurable,
              settleTimeoutMs: SHUTDOWN_SETTLE_TIMEOUT_MS,
            });
          }
          for (const outcome of outcomes) {
            if (outcome.status === "rejected") throw outcome.reason;
          }
        }),
    ).pipe(Effect.map(({ tracker }) => tracker)),
  );

export const AgentWorkPoolLive = (cfg: Config) =>
  Layer.effect(
    AgentWorkPool,
    Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const pool = createPgPool(cfg);
          try {
            await retryTransientConnect(() => runMigrations(pool));
          } catch (error) {
            await pool.end().catch(() => undefined);
            throw error;
          }
          return pool;
        },
        catch: (e) => toError(e),
      }),
      (pool) =>
        Effect.tryPromise({
          try: () => pool.end(),
          catch: (e) => toError(e),
        }).pipe(Effect.orDie),
    ),
  );

export const AgentWorkBossLive = (
  cfg: Config,
  options?: { readonly shutdownAnalytics?: boolean },
) =>
  Layer.effect(
    AgentWorkBoss,
    Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const boss = await retryTransientConnect(() => createStartedBoss(cfg));
          try {
            await ensureAgentQueues(boss, cfg);
          } catch (error) {
            await stopBoss(boss, cfg.queue.shutdownDrainTimeoutSeconds * 1000).catch(
              () => undefined,
            );
            throw error;
          }
          return boss;
        },
        catch: (e) => toError(e),
      }),
      (boss) =>
        Effect.tryPromise({
          try: async () => {
            await stopBoss(boss, cfg.queue.shutdownDrainTimeoutSeconds * 1000);
            if (options?.shutdownAnalytics !== false) await shutdownAnalytics();
          },
          catch: (e) => toError(e),
        }).pipe(Effect.orDie),
    ),
  );

export const AgentWorkSchedulerRuntimeLive = (cfg: Config) =>
  Layer.effect(
    AgentWorkScheduler,
    Effect.gen(function* () {
      const pool = yield* AgentWorkPool;
      const boss = yield* AgentWorkBoss;
      return makeAgentWorkScheduler(pool, boss, cfg);
    }),
  ).pipe(Layer.provide(AgentWorkPoolLive(cfg)), Layer.provide(AgentWorkBossLive(cfg)));
