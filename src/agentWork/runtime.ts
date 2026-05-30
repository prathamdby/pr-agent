import { Context, Effect, Layer } from "effect";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import type { Config } from "../config.js";
import { runMigrations } from "../db/migrations.js";
import { createPgPool } from "../db/postgres.js";
import { createStartedBoss, ensureAgentQueues, stopBoss } from "./boss.js";
import { AgentWorkScheduler, makeAgentWorkScheduler } from "./scheduler.js";
import { AgentWorkerLive } from "./worker.js";

export class AgentWorkPool extends Context.Tag("AgentWorkPool")<AgentWorkPool, Pool>() {}
export class AgentWorkBoss extends Context.Tag("AgentWorkBoss")<AgentWorkBoss, PgBoss>() {}

export const AgentWorkPoolLive = (cfg: Config) =>
  Layer.scoped(
    AgentWorkPool,
    Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const pool = createPgPool(cfg);
          await runMigrations(pool);
          return pool;
        },
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }),
      (pool) =>
        Effect.tryPromise({
          try: () => pool.end(),
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }).pipe(Effect.orDie),
    ),
  );

export const AgentWorkBossLive = (cfg: Config) =>
  Layer.scoped(
    AgentWorkBoss,
    Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const boss = await createStartedBoss(cfg);
          await ensureAgentQueues(boss, cfg);
          return boss;
        },
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }),
      (boss) =>
        Effect.tryPromise({
          try: () => stopBoss(boss),
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }).pipe(Effect.orDie),
    ),
  );

export const AgentWorkSchedulerRuntimeLive = (cfg: Config) =>
  Layer.effect(
    AgentWorkScheduler,
    Effect.gen(function* () {
      const pool = yield* AgentWorkPool;
      const boss = yield* AgentWorkBoss;
      return makeAgentWorkScheduler(pool, boss);
    }),
  ).pipe(Layer.provide(AgentWorkPoolLive(cfg)), Layer.provide(AgentWorkBossLive(cfg)));

export const AgentWorkerRuntimeLive = (cfg: Config) =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const pool = yield* AgentWorkPool;
      const boss = yield* AgentWorkBoss;
      yield* Layer.launch(AgentWorkerLive(cfg, pool, boss));
    }),
  ).pipe(Layer.provide(AgentWorkPoolLive(cfg)), Layer.provide(AgentWorkBossLive(cfg)));

/** Web role: scheduler seam only (webhook intake enqueues agent work). */
export const agentWorkWebLive = (cfg: Config) => AgentWorkSchedulerRuntimeLive(cfg);

/** Worker role: full queue consumers for agent work items. */
export const agentWorkWorkerLive = (cfg: Config) => AgentWorkerRuntimeLive(cfg);
