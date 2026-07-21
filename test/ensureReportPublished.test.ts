import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureReportPublished } from "../src/review/orchestrator/ensureReportPublished.js";
import { createOrchestratorSessionController } from "../src/review/orchestrator/orchestratorSessionController.js";
import { createThreadPublishRunState } from "../src/review/publish/threadPublishRunState.js";
import { makeTestConfig } from "./helpers/config.js";
import { testTokenHandle } from "./helpers/tokenHandle.js";

const publishFindingBatch = vi.fn();

vi.mock("../src/review/publish/publishFindingBatch.js", () => ({
  publishFindingBatch: (...args: unknown[]) => publishFindingBatch(...args),
}));

function makeAbort(
  overrides: {
    keepRunning?: boolean;
    deadline?: boolean;
    superseded?: boolean;
    gate?: "continue" | "deadline" | "superseded";
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
      overrides.gate ??
      (overrides.superseded ? "superseded" : overrides.deadline ? "deadline" : "continue"),
    publishGate: async () => (overrides.superseded ? "superseded" : "continue"),
    startCheapCancelMonitor: () => ({ stop: async () => undefined }),
    abortSessions: vi.fn(),
  };
}

const report = {
  specialist: "security" as const,
  kind: "report" as const,
  report: {
    status: "findings" as const,
    findings: [
      {
        severity: "P1" as const,
        file: "src/a.ts",
        startLine: 1,
        endLine: 1,
        title: "bug",
        detail: "d",
        fixPrompt: "fix",
      },
    ],
  },
  durationMs: 1,
};

describe("ensureReportPublished", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs judgment send and returns tick when publish_thread succeeds", async () => {
    const threadTool = {
      beginTurn: vi.fn(),
      hadSuccessfulCallThisTurn: vi.fn(() => true),
      getLastError: vi.fn(() => null),
      clearLastError: vi.fn(),
    };
    const sendTurn = vi.fn(async () => ({ ok: true as const, turn: { text: "judged" } }));
    const runState = createThreadPublishRunState({ postedInlineCount: 2 });

    const result = await ensureReportPublished({
      outcome: report,
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
      runState,
      abort: makeAbort(),
      controller: createOrchestratorSessionController(),
      threadTool,
      sendTurn,
    });

    expect(sendTurn).toHaveBeenCalledWith(expect.objectContaining({ phase: "judgment" }));
    expect(result.lastText).toBe("judged");
    expect(result.shouldProgressTick).toBe(true);
    expect(result.tick).toEqual({ phase: "done", threadsPublished: 0 });
    expect(publishFindingBatch).not.toHaveBeenCalled();
  });

  it("falls back to deterministic batch when judgment is skipped (degraded)", async () => {
    publishFindingBatch.mockResolvedValueOnce({ kind: "empty" });
    const controller = createOrchestratorSessionController();
    controller.markDegraded();

    const result = await ensureReportPublished({
      outcome: report,
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
      abort: makeAbort(),
      controller,
      threadTool: {
        beginTurn: vi.fn(),
        hadSuccessfulCallThisTurn: vi.fn(() => false),
        getLastError: vi.fn(() => null),
        clearLastError: vi.fn(),
      },
      sendTurn: vi.fn(),
    });

    expect(publishFindingBatch).toHaveBeenCalled();
    expect(result.shouldProgressTick).toBe(false);
    expect(result.tick).toEqual({ phase: "done", threadsPublished: 0 });
  });

  it("accumulates summary-only on deadline without GitHub batch", async () => {
    const runState = createThreadPublishRunState();
    const result = await ensureReportPublished({
      outcome: report,
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
      runState,
      abort: makeAbort({ deadline: true, keepRunning: false, gate: "deadline" }),
      controller: createOrchestratorSessionController(),
      threadTool: {
        beginTurn: vi.fn(),
        hadSuccessfulCallThisTurn: vi.fn(() => false),
        getLastError: vi.fn(() => null),
        clearLastError: vi.fn(),
      },
      sendTurn: vi.fn(),
    });

    expect(publishFindingBatch).not.toHaveBeenCalled();
    expect(runState.acceptedFindings).toHaveLength(1);
    expect(result.shouldProgressTick).toBe(false);
  });
});
