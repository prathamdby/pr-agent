import { Effect, Layer } from "effect";
import type { Config } from "../config.js";
import {
  AgentWorkBoss,
  AgentWorkBossLive,
  AgentWorkPool,
  AgentWorkPoolLive,
} from "./runtime.js";
import { AgentWorkerLive } from "./worker.js";

/** Worker role: full queue consumers for agent work items. */
export const agentWorkWorkerLive = (cfg: Config) =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const pool = yield* AgentWorkPool;
      const boss = yield* AgentWorkBoss;
      yield* Layer.launch(AgentWorkerLive(cfg, pool, boss));
    }),
  ).pipe(Layer.provide(AgentWorkPoolLive(cfg)), Layer.provide(AgentWorkBossLive(cfg)));
