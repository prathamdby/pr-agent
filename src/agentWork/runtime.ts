import { Context, Effect, Layer } from "effect";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import type { Config } from "../config.js";
import { runMigrations } from "../db/migrations.js";
import { createPgPool } from "../db/postgres.js";
import { shutdownPostHog } from "../posthog.js";
import { createStartedBoss, ensureAgentQueues, stopBoss } from "./boss.js";
import { AgentWorkScheduler, makeAgentWorkScheduler } from "./scheduler.js";
import { AgentWorkerLive } from "./worker.js";

class AgentWorkPool extends Context.Tag("AgentWorkPool")<AgentWorkPool, Pool>() {}
class AgentWorkBoss extends Context.Tag("AgentWorkBoss")<AgentWorkBoss, PgBoss>() {}

const AgentWorkPoolLive = (cfg: Config) =>
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

const AgentWorkBossLive = (cfg: Config) =>
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
          try: async () => {
            await stopBoss(boss, cfg.shutdownDrainTimeoutSeconds * 1000);
            await shutdownPostHog();
          },
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }).pipe(Effect.orDie),
    ),
  );

/** Web role: scheduler seam only (webhook intake enqueues agent work). */
export const agentWorkWebLive = (cfg: Config) =>
  Layer.effect(
    AgentWorkScheduler,
    Effect.gen(function* () {
      const pool = yield* AgentWorkPool;
      const boss = yield* AgentWorkBoss;
      return makeAgentWorkScheduler(pool, boss, cfg);
    }),
  ).pipe(Layer.provide(AgentWorkPoolLive(cfg)), Layer.provide(AgentWorkBossLive(cfg)));

/** Worker role: full queue consumers for agent work items. */
export const agentWorkWorkerLive = (cfg: Config) =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const pool = yield* AgentWorkPool;
      const boss = yield* AgentWorkBoss;
      yield* Layer.launch(AgentWorkerLive(cfg, pool, boss));
    }),
  ).pipe(Layer.provide(AgentWorkPoolLive(cfg)), Layer.provide(AgentWorkBossLive(cfg)));
