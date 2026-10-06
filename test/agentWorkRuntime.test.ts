import { Cause, Context, Effect, Exit, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import { makeTestConfig } from "./helpers/config.js";

const runtimeMocks = vi.hoisted(() => {
  const trace: string[] = [];
  const settleCalls: { timeoutMs: number; durableOnly: boolean }[] = [];
  const warnings: string[] = [];
  const pool = {
    end: vi.fn(async () => {
      trace.push("pool.end");
    }),
  };
  const boss = {};

  return {
    trace,
    settleCalls,
    warnings,
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

vi.mock("../src/agentWork/executionTracker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agentWork/executionTracker.js")>();
  return {
    ...actual,
    createExecutionTracker: () => {
      const tracker = actual.createExecutionTracker();
      return {
        track: tracker.track,
        settle: (timeoutMs: number, options?: { durableOnly?: boolean }) => {
          runtimeMocks.settleCalls.push({
            timeoutMs,
            durableOnly: options?.durableOnly === true,
          });
          return tracker.settle(timeoutMs, options);
        },
      };
    },
  };
});

vi.mock("../src/evlog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/evlog.js")>();
  return {
    ...actual,
    logWarn: (event: string) => {
      runtimeMocks.warnings.push(event);
    },
  };
});

describe("agent work runtime teardown", () => {
  it("shuts down analytics after pg-boss drains", async () => {
    runtimeMocks.trace.length = 0;
    const { AgentWorkSchedulerRuntimeLive } = await import("../src/agentWork/runtime.js");
    const cfg = makeTestConfig();

    await Effect.runPromise(Effect.scoped(Layer.build(AgentWorkSchedulerRuntimeLive(cfg))));

    expect(runtimeMocks.stopBoss).toHaveBeenCalledWith(
      runtimeMocks.boss,
      cfg.queue.shutdownDrainTimeoutSeconds * 1000,
    );
    expect(runtimeMocks.trace.filter((step) => step !== "pool.end")).toEqual([
      "boss.stop",
      "analytics.shutdown",
    ]);
    expect(runtimeMocks.trace).toContain("pool.end");
  });

  it("releases the pool after the boss drain when Boss is provided before Pool", async () => {
    runtimeMocks.trace.length = 0;
    runtimeMocks.shutdownAnalytics.mockClear();
    const { AgentWorkBossLive, AgentWorkExecutionsLive, AgentWorkPoolLive } =
      await import("../src/agentWork/runtime.js");
    const cfg = makeTestConfig({ runtime: { role: "worker" }, traces: { mode: "off" } });

    const Worker = Context.Service<"Worker", void>("Worker");
    // Same provide order as worker.ts: Boss, executions, then Pool → pool.end last.
    const workerLive = Layer.effect(
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
    ).pipe(
      Layer.provide(AgentWorkBossLive(cfg, { shutdownAnalytics: false })),
      Layer.provide(AgentWorkExecutionsLive),
      Layer.provide(AgentWorkPoolLive(cfg)),
    );

    await Effect.runPromise(Effect.scoped(Layer.build(workerLive)));

    expect(runtimeMocks.trace).toEqual([
      "worker.start",
      "worker.stop",
      "boss.stop",
      "analytics.shutdown",
      "pool.end",
    ]);
    expect(runtimeMocks.shutdownAnalytics).toHaveBeenCalledTimes(1);
  });

  it("overlaps delayed analytics with the durable reserve before ending the pool", async () => {
    runtimeMocks.trace.length = 0;
    runtimeMocks.settleCalls.length = 0;
    runtimeMocks.warnings.length = 0;
    runtimeMocks.shutdownAnalytics.mockClear();
    const { AgentWorkBossLive, AgentWorkExecutions, AgentWorkExecutionsLive, AgentWorkPoolLive } =
      await import("../src/agentWork/runtime.js");
    const cfg = makeTestConfig({ runtime: { role: "worker" }, traces: { mode: "off" } });

    let durableResolved = false;
    let releaseDurable: () => void = () => undefined;
    const durable = new Promise<void>((resolve) => {
      releaseDurable = () => {
        durableResolved = true;
        runtimeMocks.trace.push("durable.mark");
        resolve();
      };
    });
    runtimeMocks.shutdownAnalytics.mockImplementationOnce(async () => {
      runtimeMocks.trace.push("analytics.start");
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      runtimeMocks.trace.push("analytics.done");
    });

    const Worker = Context.Service<"Worker", void>("Worker");
    const workerLive = Layer.effect(
      Worker,
      Effect.acquireRelease(
        Effect.gen(function* () {
          const executions = yield* AgentWorkExecutions;
          void executions.track(() => durable, { durable: true });
        }),
        () => Effect.void,
      ),
    ).pipe(
      Layer.provide(AgentWorkBossLive(cfg, { shutdownAnalytics: false })),
      Layer.provide(AgentWorkExecutionsLive),
      Layer.provide(AgentWorkPoolLive(cfg)),
    );

    const started = Date.now();
    const disposed = Effect.runPromise(Effect.scoped(Layer.build(workerLive)));
    await vi.waitFor(
      () => {
        expect(
          runtimeMocks.settleCalls.some((call) => call.durableOnly) ||
            runtimeMocks.trace.includes("pool.end"),
        ).toBe(true);
      },
      { timeout: 15_000 },
    );
    expect(runtimeMocks.trace).toContain("analytics.start");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const poolEndedBeforeRelease = runtimeMocks.trace.includes("pool.end");
    releaseDurable();
    await disposed;

    expect(poolEndedBeforeRelease).toBe(false);
    expect(durableResolved).toBe(true);
    expect(runtimeMocks.trace).toEqual([
      "boss.stop",
      "analytics.start",
      "durable.mark",
      "analytics.done",
      "pool.end",
    ]);
    expect(Date.now() - started).toBeLessThan(8_500);
    expect(runtimeMocks.shutdownAnalytics).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.warnings).not.toContain("agent_worker_shutdown_incomplete");
  }, 20_000);

  it("waits for durable marks before propagating an analytics shutdown failure", async () => {
    runtimeMocks.trace.length = 0;
    runtimeMocks.settleCalls.length = 0;
    runtimeMocks.warnings.length = 0;
    runtimeMocks.shutdownAnalytics.mockClear();
    const { AgentWorkBossLive, AgentWorkExecutions, AgentWorkExecutionsLive, AgentWorkPoolLive } =
      await import("../src/agentWork/runtime.js");
    const cfg = makeTestConfig({ runtime: { role: "worker" }, traces: { mode: "off" } });
    const analyticsError = new Error("analytics shutdown failed");
    runtimeMocks.shutdownAnalytics.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      runtimeMocks.trace.push("analytics.failed");
      throw analyticsError;
    });
    let releaseDurable: () => void = () => undefined;
    const durable = new Promise<void>((resolve) => {
      releaseDurable = () => {
        runtimeMocks.trace.push("durable.mark");
        resolve();
      };
    });
    const Worker = Context.Service<"Worker", void>("Worker");
    const workerLive = Layer.effect(
      Worker,
      Effect.acquireRelease(
        Effect.gen(function* () {
          const executions = yield* AgentWorkExecutions;
          void executions.track(() => durable, { durable: true });
        }),
        () => Effect.void,
      ),
    ).pipe(
      Layer.provide(AgentWorkBossLive(cfg, { shutdownAnalytics: false })),
      Layer.provide(AgentWorkExecutionsLive),
      Layer.provide(AgentWorkPoolLive(cfg)),
    );

    const disposed = Effect.runPromiseExit(Effect.scoped(Layer.build(workerLive)));
    await vi.waitFor(
      () => {
        expect(runtimeMocks.trace).toContain("analytics.failed");
      },
      { timeout: 15_000 },
    );
    const poolEndedBeforeRelease = runtimeMocks.trace.includes("pool.end");
    releaseDurable();
    const exit = await disposed;

    expect(poolEndedBeforeRelease).toBe(false);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(exit.cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect)).toContain(
        analyticsError,
      );
    }
    expect(runtimeMocks.trace).toEqual([
      "boss.stop",
      "analytics.failed",
      "durable.mark",
      "pool.end",
    ]);
    expect(runtimeMocks.shutdownAnalytics).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.warnings).not.toContain("agent_worker_shutdown_incomplete");
  }, 20_000);

  it("warns and still ends the pool when a durable dispatch outlasts the reserve", async () => {
    runtimeMocks.trace.length = 0;
    runtimeMocks.settleCalls.length = 0;
    runtimeMocks.warnings.length = 0;
    const { AgentWorkBossLive, AgentWorkExecutions, AgentWorkExecutionsLive, AgentWorkPoolLive } =
      await import("../src/agentWork/runtime.js");
    const cfg = makeTestConfig({ runtime: { role: "worker" }, traces: { mode: "off" } });

    let releaseDurable: () => void = () => undefined;
    const durable = new Promise<void>((resolve) => {
      releaseDurable = resolve;
    });

    const Worker = Context.Service<"Worker", void>("Worker");
    const workerLive = Layer.effect(
      Worker,
      Effect.acquireRelease(
        Effect.gen(function* () {
          const executions = yield* AgentWorkExecutions;
          void executions.track(() => durable, { durable: true });
        }),
        () => Effect.void,
      ),
    ).pipe(
      Layer.provide(AgentWorkBossLive(cfg, { shutdownAnalytics: false })),
      Layer.provide(AgentWorkExecutionsLive),
      Layer.provide(AgentWorkPoolLive(cfg)),
    );

    const started = Date.now();
    await Effect.runPromise(Effect.scoped(Layer.build(workerLive)));
    const elapsed = Date.now() - started;

    // Five seconds of general settle plus five seconds of durable-only reserve.
    expect(elapsed).toBeGreaterThanOrEqual(9_000);
    expect(elapsed).toBeLessThan(15_000);
    expect(runtimeMocks.warnings).toContain("agent_worker_shutdown_incomplete");
    expect(runtimeMocks.trace[runtimeMocks.trace.length - 1]).toBe("pool.end");

    releaseDurable();
    await durable;
  }, 25_000);
});
