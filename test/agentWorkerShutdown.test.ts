import { Effect, Fiber, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { PgBoss } from "pg-boss";
import { createExecutionTracker } from "../src/agentWork/executionTracker.js";
import { AgentWorkExecutions, AgentWorkExecutionsLive } from "../src/agentWork/runtime.js";
import { AgentWorkerLive, stopWorkerConsumers } from "../src/agentWork/worker.js";
import { WORKER_CONSUMER_QUEUES } from "../src/agentWork/workerHealth.js";
import { ACK_QUEUE } from "../src/settings/index.js";
import { makeTestConfig } from "./helpers/config.js";

const shutdownHarness = vi.hoisted(() => {
  const ack = {
    pending: Promise.resolve() as Promise<void>,
    release: () => undefined as void,
    arm() {
      this.pending = new Promise<void>((resolve) => {
        this.release = () => resolve();
      });
    },
  };
  return { ack };
});

vi.mock("../src/evlog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/evlog.js")>();
  return {
    ...actual,
    runWithOperationLogger: <T>(_meta: unknown, fn: () => Promise<T>) => fn(),
  };
});

vi.mock("../src/agentWork/executors/ackExecutor.js", () => ({
  executeAckJob: vi.fn(() => shutdownHarness.ack.pending),
}));

vi.mock("../src/agentWork/retention.js", () => ({
  ensureRetentionSchedule: vi.fn(async () => undefined),
  runRetention: vi.fn(async () => ({})),
}));

vi.mock("../src/agentWork/lostRunningWork.js", () => ({
  reconcileLostRunningWork: vi.fn(async () => undefined),
}));

vi.mock("../src/agentWork/projectionRepair.js", () => ({
  scanProjectionRepairPending: vi.fn(async () => ({
    pendingScanned: 0,
    enqueued: 0,
    unreachable: 0,
    skippedNoInstallation: 0,
  })),
}));

vi.mock("../src/prWorkspace/index.js", () => ({
  cleanupStaleLocalPrWorkspaces: vi.fn(async () => undefined),
}));

vi.mock("../src/agentWork/workerHealth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agentWork/workerHealth.js")>();
  return {
    ...actual,
    collectQueueDiagnostics: vi.fn(async () => ({ lostRunningWorkItems: [] })),
    logQueueDiagnosticsReport: vi.fn(),
    startPeriodicQueueDiagnostics: vi.fn(() => ({ stop: () => undefined })),
    startWorkerHealthServer: vi.fn(() => ({ close: async () => undefined })),
  };
});

describe("stopWorkerConsumers", () => {
  it("calls offWork with wait:false so stopBoss can bound the drain", async () => {
    const offWork = vi.fn(async () => undefined);
    const boss = { offWork } as unknown as PgBoss;

    await stopWorkerConsumers(boss);

    expect(offWork).toHaveBeenCalledTimes(WORKER_CONSUMER_QUEUES.length);
    for (const queue of WORKER_CONSUMER_QUEUES) {
      expect(offWork).toHaveBeenCalledWith(queue, { wait: false });
    }
  });
});

describe("in-flight handler settle", () => {
  it("runs queue handlers inside the tracker and waits for them on dispose", async () => {
    shutdownHarness.ack.arm();
    const handlers = new Map<
      string,
      (jobs: readonly { id: string; data: object }[]) => Promise<void>
    >();
    const boss = {
      work: vi.fn(
        async (
          queue: string,
          _options: unknown,
          handler: (jobs: readonly { id: string; data: object }[]) => Promise<void>,
        ) => {
          handlers.set(queue, handler);
          return "worker-id";
        },
      ),
      offWork: vi.fn(async () => undefined),
    };
    const fiber = Effect.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          const executions = yield* AgentWorkExecutions;
          yield* Layer.launch(
            AgentWorkerLive(
              makeTestConfig({ role: "worker" }),
              {} as never,
              boss as never,
              executions,
            ),
          );
          yield* Effect.never;
        }).pipe(Effect.provide(AgentWorkExecutionsLive)),
      ),
    );

    await vi.waitFor(() => {
      expect(handlers.has(ACK_QUEUE)).toBe(true);
    });

    let handlerFinished = false;
    void handlers.get(ACK_QUEUE)!([{ id: "job-1", data: { workItemId: "w1" } }]).then(() => {
      handlerFinished = true;
    });
    await Promise.resolve();

    const disposed = Effect.runPromise(Fiber.interrupt(fiber));
    const raced = await Promise.race([
      disposed.then(() => "disposed" as const),
      new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 20)),
    ]);
    expect(raced).toBe("waiting");
    expect(handlerFinished).toBe(false);

    shutdownHarness.ack.release();
    await disposed;
    expect(handlerFinished).toBe(true);
  });

  it("returns from dispose when an in-flight handler outlasts the settle timeout", async () => {
    let releaseHandler: () => void = () => undefined;
    const handler = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });

    let releaseScope: () => void = () => undefined;
    const holdScope = new Promise<void>((resolve) => {
      releaseScope = resolve;
    });
    const disposed = Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const executions = yield* AgentWorkExecutions;
          yield* Effect.promise(async () => {
            void executions.track(() => handler);
          });
          yield* Effect.promise(() => holdScope);
        }).pipe(Effect.provide(AgentWorkExecutionsLive)),
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    const started = Date.now();
    releaseScope();
    await disposed;
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(4_500);
    expect(elapsed).toBeLessThan(7_000);
    releaseHandler();
  }, 15_000);

  it("resolves settle immediately when nothing is in flight and stops at the timeout", async () => {
    const tracker = createExecutionTracker();
    const started = Date.now();
    await tracker.settle(5_000);
    expect(Date.now() - started).toBeLessThan(50);

    let release: () => void = () => undefined;
    const hanging = new Promise<void>((resolve) => {
      release = resolve;
    });
    void tracker.track(() => hanging);
    const bounded = Date.now();
    await tracker.settle(30);
    expect(Date.now() - bounded).toBeLessThan(250);
    expect(Date.now() - bounded).toBeGreaterThanOrEqual(20);
    release();
    await hanging;
  });
});
