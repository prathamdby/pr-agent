import { Context, Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgBoss } from "pg-boss";
import { Pool } from "pg";
import { makeTestConfig } from "./helpers/config.js";
import * as postgres from "../src/db/postgres.js";
import * as migrations from "../src/db/migrations.js";
import * as bossModule from "../src/agentWork/boss.js";
import * as analytics from "../src/analytics/index.js";
import {
  AgentWorkBossLive,
  AgentWorkPoolLive,
  agentWorkWebLive,
} from "../src/agentWork/runtime.js";

describe("agent work runtime teardown", () => {
  const trace: string[] = [];
  let pool: Pool;
  let boss: PgBoss;

  beforeEach(() => {
    trace.length = 0;
    pool = new Pool({ connectionString: "postgres://127.0.0.1:1/unused" });
    boss = new PgBoss({ connectionString: "postgres://127.0.0.1:1/unused" });
    vi.spyOn(pool, "end").mockImplementation(async () => {
      trace.push("pool.end");
    });
    vi.spyOn(postgres, "createPgPool").mockReturnValue(pool);
    vi.spyOn(migrations, "runMigrations").mockResolvedValue(undefined);
    vi.spyOn(bossModule, "createStartedBoss").mockResolvedValue(boss);
    vi.spyOn(bossModule, "ensureAgentQueues").mockResolvedValue(undefined);
    vi.spyOn(bossModule, "stopBoss").mockImplementation(async () => {
      trace.push("boss.stop");
    });
    vi.spyOn(analytics, "shutdownAnalytics").mockImplementation(async () => {
      trace.push("analytics.shutdown");
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shuts down analytics after pg-boss drains", async () => {
    const cfg = makeTestConfig();

    await Effect.runPromise(Effect.scoped(Layer.build(agentWorkWebLive(cfg))));

    expect(bossModule.stopBoss).toHaveBeenCalledWith(boss, cfg.shutdownDrainTimeoutSeconds * 1000);
    expect(trace.filter((step) => step !== "pool.end")).toEqual([
      "boss.stop",
      "analytics.shutdown",
    ]);
    expect(trace).toContain("pool.end");
  });

  it("releases the pool after the boss drain when Boss is provided before Pool", async () => {
    const cfg = makeTestConfig({ role: "worker" });

    const Worker = Context.GenericTag<"Worker", void>("Worker");
    // Same provide order as workerRuntime: Boss then Pool → pool.end last.
    const workerLive = Layer.scoped(
      Worker,
      Effect.acquireRelease(
        Effect.sync(() => {
          trace.push("worker.start");
        }),
        () =>
          Effect.sync(() => {
            trace.push("worker.stop");
          }),
      ),
    ).pipe(Layer.provide(AgentWorkBossLive(cfg)), Layer.provide(AgentWorkPoolLive(cfg)));

    await Effect.runPromise(Effect.scoped(Layer.build(workerLive)));

    expect(trace).toEqual([
      "worker.start",
      "worker.stop",
      "boss.stop",
      "analytics.shutdown",
      "pool.end",
    ]);
  });
});
