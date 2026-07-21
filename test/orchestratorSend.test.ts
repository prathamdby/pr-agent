import { describe, expect, it, vi } from "vitest";
import { AppError } from "../src/errors/appError.js";
import type { AgentRunnerSession, AgentRunnerTurn } from "../src/agent/providers/interface.js";
import { sendOrchestratorTurnOnceWithRetry } from "../src/review/orchestrator/orchestratorSend.js";

function makeSession(sendImpl: AgentRunnerSession["send"]): AgentRunnerSession {
  return {
    send: sendImpl,
    restoreTools: vi.fn(),
    restrictToTools: vi.fn(),
    abort: vi.fn(),
    dispose: vi.fn(async () => undefined),
  };
}

describe("sendOrchestratorTurnOnceWithRetry", () => {
  it("does not invoke the external abort probe after a successful send returns", async () => {
    let probeCalls = 0;
    const turn: AgentRunnerTurn = { text: "ok" };
    const session = makeSession(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      return turn;
    });

    const result = await sendOrchestratorTurnOnceWithRetry({
      session,
      prompt: "hello",
      phase: "synthesis",
      shouldSend: () => true,
      deadlineAtMs: Date.now() + 60_000,
      now: () => Date.now(),
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      abortPollMs: 10,
      shouldAbortExternal: async () => {
        probeCalls += 1;
        return false;
      },
    });

    expect(result).toEqual({ ok: true, turn });
    const probesAtReturn = probeCalls;
    expect(probesAtReturn).toBeGreaterThan(0);
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    expect(probeCalls).toBe(probesAtReturn);
  });

  it("returns superseded when the external abort probe flips true during send", async () => {
    const session = makeSession(async () => {
      await new Promise<void>(() => undefined);
      return { text: "never" };
    });

    let probe = false;
    setTimeout(() => {
      probe = true;
    }, 20);

    const result = await sendOrchestratorTurnOnceWithRetry({
      session,
      prompt: "hang",
      phase: "synthesis",
      shouldSend: () => true,
      deadlineAtMs: Date.now() + 60_000,
      now: () => Date.now(),
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      abortPollMs: 10,
      shouldAbortExternal: async () => probe,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("superseded");
      expect(result.error).toBeInstanceOf(AppError);
    }
    expect(session.abort).toHaveBeenCalled();
  });
});
