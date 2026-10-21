import { Cause, Context, Effect, Exit, Layer } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRANSIENT_CONNECT_ATTEMPTS } from "../src/db/transientConnect.ts";
import { makeTestConfig } from "./helpers/config.ts";

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

vi.mock("../src/db/postgres.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db/postgres.ts")>();
  return { ...actual, createPgPool: runtimeMocks.createPgPool };
});

vi.mock("../src/db/migrations.ts", () => ({ runMigrations: runtimeMocks.runMigrations }));

vi.mock("../src/agentWork/boss.ts", () => ({
  createStartedBoss: runtimeMocks.createStartedBoss,
  ensureAgentQueues: runtimeMocks.ensureAgentQueues,
  stopBoss: runtimeMocks.stopBoss,
}));

vi.mock("../src/analytics/index.ts", () => ({
  shutdownAnalytics: runtimeMocks.shutdownAnalytics,
}));

vi.mock("../src/agentWork/executionTracker.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agentWork/executionTracker.ts")>();
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

vi.mock("../src/db/transientConnect.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db/transientConnect.ts")>();
  return {
    ...actual,
    retryTransientConnect: (
      operation: () => Promise<unknown>,
      sleep?: (delayMs: number) => Promise<void>,
    ) => actual.retryTransientConnect(operation, sleep ?? (async () => undefined)),
  };
});

vi.mock("../src/evlog.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/evlog.ts")>();
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
    const { AgentWorkSchedulerRuntimeLive } = await import("../src/agentWork/runtime.ts");
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
      await import("../src/agentWork/runtime.ts");
    const cfg = makeTestConfig({ runtime: { role: "worker" } });

    const Worker = Context.Service<"Worker", void>("Worker");
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
      Layer.provide(AgentWorkExecutionsLive(cfg)),
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
      await import("../src/agentWork/runtime.ts");
    const cfg = makeTestConfig({ runtime: { role: "worker" } });

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
      Layer.provide(AgentWorkExecutionsLive(cfg)),
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
      await import("../src/agentWork/runtime.ts");
    const cfg = makeTestConfig({ runtime: { role: "worker" } });
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
      Layer.provide(AgentWorkExecutionsLive(cfg)),
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
      await import("../src/agentWork/runtime.ts");
    const cfg = makeTestConfig({ runtime: { role: "worker" } });

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
      Layer.provide(AgentWorkExecutionsLive(cfg)),
      Layer.provide(AgentWorkPoolLive(cfg)),
    );

    const started = Date.now();
    await Effect.runPromise(Effect.scoped(Layer.build(workerLive)));
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(9_000);
    expect(elapsed).toBeLessThan(15_000);
    expect(runtimeMocks.warnings).toContain("agent_worker_shutdown_incomplete");
    expect(runtimeMocks.trace[runtimeMocks.trace.length - 1]).toBe("pool.end");

    releaseDurable();
    await durable;
  }, 25_000);
});

function connectError(code: string): Error {
  const error = new Error(`connect ${code}`);
  return Object.assign(error, { code });
}

function restoreBootDoubles(): void {
  runtimeMocks.runMigrations.mockReset();
  runtimeMocks.runMigrations.mockImplementation(async () => undefined);
  runtimeMocks.createStartedBoss.mockReset();
  runtimeMocks.createStartedBoss.mockImplementation(async () => runtimeMocks.boss);
  runtimeMocks.ensureAgentQueues.mockClear();
  runtimeMocks.warnings.length = 0;
}

describe("agent work runtime boot", () => {
  beforeEach(() => {
    restoreBootDoubles();
  });

  it.each(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ETIMEDOUT"] as const)(
    "opens the pool after one %s connect failure",
    async (code) => {
      runtimeMocks.runMigrations
        .mockRejectedValueOnce(connectError(code))
        .mockResolvedValueOnce(undefined);
      const { AgentWorkPoolLive } = await import("../src/agentWork/runtime.ts");

      const exit = await Effect.runPromiseExit(
        Effect.scoped(Layer.build(AgentWorkPoolLive(makeTestConfig()))),
      );

      expect(runtimeMocks.runMigrations).toHaveBeenCalledTimes(2);
      expect(runtimeMocks.warnings).toEqual(["postgres_connect_retry"]);
      expect(Exit.isSuccess(exit)).toBe(true);
    },
  );

  it("starts pg-boss after one ENOTFOUND connect failure", async () => {
    runtimeMocks.createStartedBoss
      .mockRejectedValueOnce(connectError("ENOTFOUND"))
      .mockResolvedValueOnce(runtimeMocks.boss);
    const { AgentWorkBossLive } = await import("../src/agentWork/runtime.ts");

    const exit = await Effect.runPromiseExit(
      Effect.scoped(Layer.build(AgentWorkBossLive(makeTestConfig()))),
    );

    expect(runtimeMocks.createStartedBoss).toHaveBeenCalledTimes(2);
    expect(runtimeMocks.warnings).toEqual(["postgres_connect_retry"]);
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("fails pool boot when ENOTFOUND outlasts the bound", async () => {
    runtimeMocks.runMigrations.mockRejectedValue(connectError("ENOTFOUND"));
    const { AgentWorkPoolLive } = await import("../src/agentWork/runtime.ts");

    const exit = await Effect.runPromiseExit(
      Effect.scoped(Layer.build(AgentWorkPoolLive(makeTestConfig()))),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(runtimeMocks.runMigrations).toHaveBeenCalledTimes(TRANSIENT_CONNECT_ATTEMPTS);
    expect(runtimeMocks.warnings).toHaveLength(TRANSIENT_CONNECT_ATTEMPTS - 1);
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toMatchObject({ code: "ENOTFOUND" });
    }
  });

  it("fails pg-boss boot when ENOTFOUND outlasts the bound", async () => {
    runtimeMocks.createStartedBoss.mockRejectedValue(connectError("ENOTFOUND"));
    const { AgentWorkBossLive } = await import("../src/agentWork/runtime.ts");

    const exit = await Effect.runPromiseExit(
      Effect.scoped(Layer.build(AgentWorkBossLive(makeTestConfig()))),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(runtimeMocks.createStartedBoss).toHaveBeenCalledTimes(TRANSIENT_CONNECT_ATTEMPTS);
    expect(runtimeMocks.warnings).toHaveLength(TRANSIENT_CONNECT_ATTEMPTS - 1);
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toMatchObject({ code: "ENOTFOUND" });
    }
  });

  it("fails pool boot on the first non-transient connect error", async () => {
    runtimeMocks.runMigrations.mockRejectedValue(connectError("28P01"));
    const { AgentWorkPoolLive } = await import("../src/agentWork/runtime.ts");

    const exit = await Effect.runPromiseExit(
      Effect.scoped(Layer.build(AgentWorkPoolLive(makeTestConfig()))),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(runtimeMocks.runMigrations).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.warnings).not.toContain("postgres_connect_retry");
  });
});
