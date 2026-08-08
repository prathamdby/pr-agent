import { Effect, Layer } from "effect";
import type { Config } from "../config.js";
import { AgentWorkBoss, AgentWorkBossLive, AgentWorkPool, AgentWorkPoolLive } from "./runtime.js";
import { AgentWorkerLive } from "./worker.js";

/**
 * Worker role: full queue consumers for agent work items.
 * Provide Boss before Pool so finalizers run worker → boss drain → pool.end;
 * a draining handler can still record its outcome while the Pool is alive.
 */
export const agentWorkWorkerLive = (cfg: Config) =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const pool = yield* AgentWorkPool;
      const boss = yield* AgentWorkBoss;
      yield* Layer.launch(AgentWorkerLive(cfg, pool, boss));
    }),
  ).pipe(Layer.provide(AgentWorkBossLive(cfg)), Layer.provide(AgentWorkPoolLive(cfg)));
