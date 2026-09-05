import { Context, Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import { makeTestConfig } from "./helpers/config.js";

const runtimeMocks = vi.hoisted(() => {
  const trace: string[] = [];
  const pool = {
    end: vi.fn(async () => {
      trace.push("pool.end");
    }),
  };
  const boss = {};

  return {
    trace,
    pool,
    boss,
    createPgPool: vi.fn(() => pool),
    runMigrations: vi.fn(async () => undefined),
    createStartedBoss: vi.fn(async () => boss),
    ensureAgentQueues: vi.fn(async () => undefined),
    stopBoss: vi.fn(async () => {
      trace.push("boss.stop");
    }),
    shutdownAnalytics: vi.fn(async () => {
      trace.push("analytics.shutdown");
    }),
  };
});

vi.mock("../src/db/postgres.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db/postgres.js")>();
  return { ...actual, createPgPool: runtimeMocks.createPgPool };
});

vi.mock("../src/db/migrations.js", () => ({ runMigrations: runtimeMocks.runMigrations }));

vi.mock("../src/agentWork/boss.js", () => ({
  createStartedBoss: runtimeMocks.createStartedBoss,
  ensureAgentQueues: runtimeMocks.ensureAgentQueues,
  stopBoss: runtimeMocks.stopBoss,
}));

vi.mock("../src/analytics/index.js", () => ({
  shutdownAnalytics: runtimeMocks.shutdownAnalytics,
}));

describe("agent work runtime teardown", () => {
  it("shuts down analytics after pg-boss drains", async () => {
    runtimeMocks.trace.length = 0;
    const { agentWorkWebLive } = await import("../src/agentWork/runtime.js");
    const cfg = makeTestConfig();

    await Effect.runPromise(Effect.scoped(Layer.build(agentWorkWebLive(cfg))));

    expect(runtimeMocks.stopBoss).toHaveBeenCalledWith(
      runtimeMocks.boss,
      cfg.shutdownDrainTimeoutSeconds * 1000,
    );
    expect(runtimeMocks.trace.filter((step) => step !== "pool.end")).toEqual([
      "boss.stop",
      "analytics.shutdown",
    ]);
    expect(runtimeMocks.trace).toContain("pool.end");
  });

  it("releases the pool after the boss drain when Boss is provided before Pool", async () => {
    runtimeMocks.trace.length = 0;
    const { AgentWorkBossLive, AgentWorkPoolLive } = await import("../src/agentWork/runtime.js");
    const cfg = makeTestConfig({ role: "worker" });

    const Worker = Context.GenericTag<"Worker", void>("Worker");
    // Same provide order as worker.ts: Boss then Pool → pool.end last.
    const workerLive = Layer.scoped(
      Worker,
      Effect.acquireRelease(
        Effect.sync(() => {
          runtimeMocks.trace.push("worker.start");
        }),
        () =>
          Effect.sync(() => {
            runtimeMocks.trace.push("worker.stop");
          }),
      ),
    ).pipe(Layer.provide(AgentWorkBossLive(cfg)), Layer.provide(AgentWorkPoolLive(cfg)));

    await Effect.runPromise(Effect.scoped(Layer.build(workerLive)));

    expect(runtimeMocks.trace).toEqual([
      "worker.start",
      "worker.stop",
      "boss.stop",
      "analytics.shutdown",
      "pool.end",
    ]);
  });
});
