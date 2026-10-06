import { Context, Effect, Layer } from "effect";
import type { Pool, PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import { type Config, SHUTDOWN_SETTLE_TIMEOUT_MS } from "../settings/index.js";
import { runMigrations } from "../db/migrations.js";
import { createPgPool } from "../db/postgres.js";
import { shutdownAnalytics } from "../analytics/index.js";
import { initTraces } from "../traces/recorder.js";
import { logWarn } from "../evlog.js";
import { createStartedBoss, ensureAgentQueues, stopBoss } from "./boss.js";
import { createExecutionTracker, type ExecutionTracker } from "./executionTracker.js";
import { AgentWorkScheduler, makeAgentWorkScheduler } from "./scheduler.js";
import { toError } from "../errors/errorMessage.js";

export class AgentWorkPool extends Context.Service<AgentWorkPool, Pool>()("AgentWorkPool") {}
export class AgentWorkBoss extends Context.Service<AgentWorkBoss, PgBoss>()("AgentWorkBoss") {}
export class AgentWorkExecutions extends Context.Service<AgentWorkExecutions, ExecutionTracker>()(
  "AgentWorkExecutions",
) {}

function closeTraceClient(client: PoolClient): void {
  void client.end().catch(() => logWarn("agent_trace_pool_close_failed"));
}

function openWorkerTraces(cfg: Config): () => Promise<void> {
  if (cfg.runtime.role !== "worker" || cfg.traces.mode === "off") return async () => undefined;
  try {
    const pool = createPgPool(cfg, 2);
    const borrowed = new Set<PoolClient>();
    let closing = false;
    pool.on("acquire", (client) => {
      if (closing) closeTraceClient(client);
      else borrowed.add(client);
    });
    pool.on("release", (_error, client) => borrowed.delete(client));
    const drain = initTraces(pool, cfg);
    return async () => {
      try {
        await drain();
      } finally {
        closing = true;
        const ended = pool.end();
        // pool.end waits for checked-out clients. A timed-out trace write
        // must release its socket without touching the durable work pool.
        for (const client of borrowed) closeTraceClient(client);
        await ended.catch(() => logWarn("agent_trace_pool_close_failed"));
      }
    };
  } catch {
    logWarn("agent_trace_init_failed");
    return async () => undefined;
  }
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
          // Durable dispatches write terminal work-item marks: give them one more
          // bounded window before the pool ends, concurrent with the bounded
          // analytics flush so PostHog cannot delay those marks. Settled handling
          // keeps the flush running even if a settle branch fails.
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
          await runMigrations(pool);
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
          const boss = await createStartedBoss(cfg);
          await ensureAgentQueues(boss, cfg);
          return boss;
        },
        catch: (e) => toError(e),
      }),
      (boss) =>
        Effect.tryPromise({
          try: async () => {
            await stopBoss(boss, cfg.queue.shutdownDrainTimeoutSeconds * 1000);
            // The worker flushes analytics from its executions finalizer instead,
            // so the flush runs concurrently with the durable-dispatch reserve.
            if (options?.shutdownAnalytics !== false) await shutdownAnalytics();
          },
          catch: (e) => toError(e),
        }).pipe(Effect.orDie),
    ),
  );

/** Web role: scheduler seam only (webhook intake enqueues agent work). */
export const AgentWorkSchedulerRuntimeLive = (cfg: Config) =>
  Layer.effect(
    AgentWorkScheduler,
    Effect.gen(function* () {
      const pool = yield* AgentWorkPool;
      const boss = yield* AgentWorkBoss;
      return makeAgentWorkScheduler(pool, boss, cfg);
    }),
  ).pipe(Layer.provide(AgentWorkPoolLive(cfg)), Layer.provide(AgentWorkBossLive(cfg)));
