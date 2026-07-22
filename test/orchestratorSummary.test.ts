import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../src/errors/appError.js";
import { createCachedPrDiffIndex } from "../src/review/placement/reviewDiffIndex.js";
import { runSummaryPhase } from "../src/review/orchestrator/orchestratorSummary.js";
import { createOrchestratorSessionController } from "../src/review/orchestrator/orchestratorSessionController.js";
import type {
  OrchestratorSendFailureReason,
  OrchestratorSendResult,
} from "../src/review/orchestrator/orchestratorSend.js";
import { createThreadPublishRunState } from "../src/review/publish/threadPublishRunState.js";
import { makeTestConfig } from "./helpers/config.js";
import { testTokenHandle } from "./helpers/tokenHandle.js";

const finalizeReviewSummary = vi.fn();

vi.mock("../src/review/orchestrator/summaryFinalizer.js", () => ({
  finalizeReviewSummary: (...args: unknown[]) => finalizeReviewSummary(...args),
}));

const brief = {
  prIntent: "intent",
  architectureNotes: "",
  riskAreas: [],
  fileMap: "",
  specialistFocus: {
    correctness: "c",
    security: "s",
    quality: "q",
    tests: "t",
  },
};

function makeAbort(
  overrides: {
    keepRunning?: boolean;
    deadline?: boolean;
    superseded?: boolean;
  } = {},
) {
  const keepRunning = overrides.keepRunning ?? true;
  return {
    signal: new AbortController().signal,
    deadlineAtMs: Date.now() + 60_000,
    markSuperseded: vi.fn(),
    isSuperseded: () => overrides.superseded === true,
    deadlinePassed: () => overrides.deadline === true,
    shouldKeepRunning: () =>
      keepRunning && overrides.superseded !== true && overrides.deadline !== true,
    gate: async () =>
      overrides.superseded
        ? ("superseded" as const)
        : overrides.deadline
          ? ("deadline" as const)
          : ("continue" as const),
    publishGate: async () =>
      overrides.superseded ? ("superseded" as const) : ("continue" as const),
    startCheapCancelMonitor: () => ({ stop: async () => undefined }),
    abortSessions: vi.fn(),
  };
}

function failResult(reason: OrchestratorSendFailureReason) {
  return {
    ok: false as const,
    reason,
    error: new AppError({
      code: `review.orchestrator_send_${reason}`,
      message: `${reason} send`,
      context: { reason },
    }),
  };
}

function makeSummaryTool(
  overrides: {
    hasCaptured?: boolean;
    lastError?: string | null;
  } = {},
) {
  return {
    piTool: { name: "publish_summary" },
    executor: vi.fn(),
    getLastError: vi.fn(() => overrides.lastError ?? null),
    clearLastError: vi.fn(),
    getCapturedOverview: vi.fn(() => null),
    hasCaptured: vi.fn(() => overrides.hasCaptured === true),
  };
}

async function runPhase(args: {
  controller: ReturnType<typeof createOrchestratorSessionController>;
  sendTurn: (args: {
    readonly prompt: string;
    readonly opts?: { readonly maxToolRounds?: number };
    readonly phase: string;
    readonly shouldSend?: () => boolean;
  }) => Promise<OrchestratorSendResult>;
  summaryTool?: ReturnType<typeof makeSummaryTool>;
  abort?: ReturnType<typeof makeAbort>;
}) {
  return runSummaryPhase({
    cfg: makeTestConfig(),
    ctx: {
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "sha",
      hasDescriptionAgentBlock: false,
    },
    token: testTokenHandle(),
    recordPublishStep: vi.fn(async () => undefined),
    runState: createThreadPublishRunState(),
    cachedDiffIndex: createCachedPrDiffIndex(),
    abort: args.abort ?? makeAbort(),
    controller: args.controller,
    summaryTool: (args.summaryTool ?? makeSummaryTool()) as never,
    brief,
    outcomes: [],
    forceDeterministic: false,
    deadlineReached: false,
    owner: "o",
    repo: "r",
    prNumber: 1,
    restoreThenRestrict: vi.fn(),
    sendTurn: args.sendTurn,
  });
}

describe("runSummaryPhase send degradation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    finalizeReviewSummary.mockResolvedValue({ published: true });
  });

  it.each([
    { reason: "failed" as const, marksDegraded: true },
    { reason: "deadline" as const, marksDegraded: false },
    { reason: "superseded" as const, marksDegraded: false },
    { reason: "skipped" as const, marksDegraded: false },
  ])(
    "synthesis send reason=$reason marks degraded=$marksDegraded",
    async ({ reason, marksDegraded }) => {
      const controller = createOrchestratorSessionController();
      const sendTurn = vi.fn(async () => failResult(reason));

      const result = await runPhase({ controller, sendTurn });

      expect(sendTurn).toHaveBeenCalledWith(expect.objectContaining({ phase: "synthesis" }));
      expect(controller.isDegraded()).toBe(marksDegraded);
      expect(result.judgmentDegraded).toBe(marksDegraded);
    },
  );

  it.each([
    { reason: "failed" as const, marksDegraded: true },
    { reason: "deadline" as const, marksDegraded: false },
    { reason: "superseded" as const, marksDegraded: false },
    { reason: "skipped" as const, marksDegraded: false },
  ])(
    "validation_repair reason=$reason marks degraded=$marksDegraded",
    async ({ reason, marksDegraded }) => {
      const controller = createOrchestratorSessionController();
      const summaryTool = makeSummaryTool({ lastError: "publish_summary validation failed" });
      const sendTurn = vi.fn(async (args: { phase: string }) => {
        if (args.phase === "synthesis") return { ok: true as const, turn: { text: "synth" } };
        return failResult(reason);
      });

      const result = await runPhase({ controller, sendTurn, summaryTool });

      expect(sendTurn).toHaveBeenCalledWith(
        expect.objectContaining({ phase: "validation_repair" }),
      );
      expect(controller.isDegraded()).toBe(marksDegraded);
      expect(result.judgmentDegraded).toBe(marksDegraded);
    },
  );

  it.each([
    { reason: "failed" as const, marksDegraded: true },
    { reason: "deadline" as const, marksDegraded: false },
    { reason: "superseded" as const, marksDegraded: false },
    { reason: "skipped" as const, marksDegraded: false },
  ])(
    "synthesis_recovery reason=$reason marks degraded=$marksDegraded",
    async ({ reason, marksDegraded }) => {
      const controller = createOrchestratorSessionController();
      const summaryTool = makeSummaryTool();
      const sendTurn = vi.fn(async (args: { phase: string }) => {
        if (args.phase === "synthesis") return { ok: true as const, turn: { text: "synth" } };
        return failResult(reason);
      });

      const result = await runPhase({ controller, sendTurn, summaryTool });

      expect(sendTurn).toHaveBeenCalledWith(
        expect.objectContaining({ phase: "synthesis_recovery" }),
      );
      expect(controller.isDegraded()).toBe(marksDegraded);
      expect(result.judgmentDegraded).toBe(marksDegraded);
    },
  );

  it("marks degraded when synthesis succeeds but publish_summary is never called", async () => {
    const controller = createOrchestratorSessionController();
    const sendTurn = vi.fn(async () => ({ ok: true as const, turn: { text: "no tool" } }));

    const result = await runPhase({ controller, sendTurn });

    expect(controller.isDegraded()).toBe(true);
    expect(result.judgmentDegraded).toBe(true);
  });
});
