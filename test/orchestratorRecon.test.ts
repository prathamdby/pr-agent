import { describe, expect, it, vi } from "vitest";
import { AppError } from "../src/errors/appError.js";
import { createCachedPrDiffIndex } from "../src/review/placement/reviewDiffIndex.js";
import { runReconPhase } from "../src/review/orchestrator/orchestratorRecon.js";
import { createOrchestratorSessionController } from "../src/review/orchestrator/orchestratorSessionController.js";
import type { OrchestratorSendFailureReason } from "../src/review/orchestrator/orchestratorSend.js";

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

function makeBriefTool(overrides: { lastError?: string | null } = {}) {
  return {
    piTool: { name: "submit_specialist_brief" },
    executor: vi.fn(),
    getBrief: vi.fn(() => null),
    getLastError: vi.fn(() => overrides.lastError ?? null),
    clearLastError: vi.fn(),
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

describe("runReconPhase send degradation", () => {
  it.each([
    { reason: "failed" as const, marksDegraded: true },
    { reason: "deadline" as const, marksDegraded: false },
    { reason: "superseded" as const, marksDegraded: false },
    { reason: "skipped" as const, marksDegraded: false },
  ])(
    "recon send reason=$reason marks degraded=$marksDegraded",
    async ({ reason, marksDegraded }) => {
      const controller = createOrchestratorSessionController();
      const sendTurn = vi.fn(async () => failResult(reason));

      const result = await runReconPhase({
        session: {
          send: vi.fn(),
          restoreTools: vi.fn(),
          restrictToTools: vi.fn(),
          abort: vi.fn(),
          dispose: vi.fn(async () => undefined),
        },
        abort: makeAbort(),
        controller,
        briefTool: makeBriefTool() as never,
        cachedDiffIndex: createCachedPrDiffIndex(),
        prTitle: "t",
        prBody: "b",
        owner: "o",
        repo: "r",
        prNumber: 1,
        restoreThenRestrict: vi.fn(),
        sendTurn,
      });

      expect(sendTurn).toHaveBeenCalledWith(expect.objectContaining({ phase: "recon" }));
      expect(controller.isDegraded()).toBe(marksDegraded);
      expect(result.briefFallback).toBe(true);
    },
  );

  it.each([
    { reason: "failed" as const, marksDegraded: true },
    { reason: "deadline" as const, marksDegraded: false },
    { reason: "superseded" as const, marksDegraded: false },
    { reason: "skipped" as const, marksDegraded: false },
  ])(
    "recon_repair reason=$reason marks degraded=$marksDegraded",
    async ({ reason, marksDegraded }) => {
      const controller = createOrchestratorSessionController();
      const briefTool = makeBriefTool({
        lastError: "Call submit_specialist_brief exactly once.",
      });
      const sendTurn = vi.fn(async (args: { phase: string }) => {
        if (args.phase === "recon") return { ok: true as const, turn: { text: "recon" } };
        return failResult(reason);
      });

      await runReconPhase({
        session: {
          send: vi.fn(),
          restoreTools: vi.fn(),
          restrictToTools: vi.fn(),
          abort: vi.fn(),
          dispose: vi.fn(async () => undefined),
        },
        abort: makeAbort(),
        controller,
        briefTool: briefTool as never,
        cachedDiffIndex: createCachedPrDiffIndex(),
        prTitle: "t",
        prBody: "b",
        owner: "o",
        repo: "r",
        prNumber: 1,
        restoreThenRestrict: vi.fn(),
        sendTurn,
      });

      expect(sendTurn).toHaveBeenCalledWith(expect.objectContaining({ phase: "recon_repair" }));
      expect(controller.isDegraded()).toBe(marksDegraded);
    },
  );
});
