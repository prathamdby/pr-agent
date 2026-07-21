import { describe, expect, it, vi } from "vitest";
import { createOrchestratorSessionController } from "../src/review/orchestrator/orchestratorSessionController.js";

describe("orchestratorSessionController", () => {
  it("starts healthy and can send until markDegraded", () => {
    const controller = createOrchestratorSessionController();
    expect(controller.isDegraded()).toBe(false);
    expect(controller.canSendOrchestrator()).toBe(true);

    controller.markDegraded();
    expect(controller.isDegraded()).toBe(true);
    expect(controller.canSendOrchestrator()).toBe(false);
  });
});

describe("runAbortScope", () => {
  it("keeps deadline distinct from supersede", async () => {
    const { createRunAbortScope } = await import("../src/review/orchestrator/runAbortScope.js");
    const session = {
      abort: vi.fn(),
      send: vi.fn(),
      restrictToTools: vi.fn(),
      restoreTools: vi.fn(),
      dispose: vi.fn(async () => undefined),
    };
    let nowMs = 1_000;
    const abort = createRunAbortScope({
      deadlineAtMs: 2_000,
      now: () => nowMs,
      sleep: async () => undefined,
      session,
    });

    expect(await abort.gate()).toBe("continue");
    expect(await abort.publishGate()).toBe("continue");
    expect(abort.shouldKeepRunning()).toBe(true);

    nowMs = 2_500;
    expect(abort.deadlinePassed()).toBe(true);
    expect(abort.shouldKeepRunning()).toBe(false);
    expect(await abort.gate()).toBe("deadline");
    // Publish gate must not block deterministic summary on internal deadline.
    expect(await abort.publishGate()).toBe("continue");
    expect(abort.isSuperseded()).toBe(false);

    abort.markSuperseded();
    expect(abort.isSuperseded()).toBe(true);
    expect(await abort.gate()).toBe("superseded");
    expect(await abort.publishGate()).toBe("superseded");
    expect(session.abort).toHaveBeenCalled();
  });

  it("publishGate reports stale_head from owned publishAbortState", async () => {
    const { createRunAbortScope } = await import("../src/review/orchestrator/runAbortScope.js");
    const session = {
      abort: vi.fn(),
      send: vi.fn(),
      restrictToTools: vi.fn(),
      restoreTools: vi.fn(),
      dispose: vi.fn(async () => undefined),
    };
    const publishAbortState: { staleHead?: boolean } = {};
    const abort = createRunAbortScope({
      deadlineAtMs: Date.now() + 60_000,
      now: () => Date.now(),
      sleep: async () => undefined,
      session,
      publishAbortState,
      shouldAbortPublish: async () => {
        publishAbortState.staleHead = true;
        return true;
      },
    });

    expect(await abort.publishGate()).toBe("stale_head");
    expect(abort.isSuperseded()).toBe(true);
  });

  it("cheap cancel monitor marks superseded without requiring full publish gate", async () => {
    const { createRunAbortScope } = await import("../src/review/orchestrator/runAbortScope.js");
    const session = {
      abort: vi.fn(),
      send: vi.fn(),
      restrictToTools: vi.fn(),
      restoreTools: vi.fn(),
      dispose: vi.fn(async () => undefined),
    };
    let cancel = false;
    const abort = createRunAbortScope({
      deadlineAtMs: Date.now() + 60_000,
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
      session,
      shouldCancelRun: async () => cancel,
      shouldAbortPublish: async () => {
        throw new Error("full gate must not run on cheap monitor");
      },
    });

    const monitor = abort.startCheapCancelMonitor({ pollMs: 5 });
    cancel = true;
    await vi.waitFor(() => expect(abort.isSuperseded()).toBe(true));
    await monitor.stop();
  });
});
