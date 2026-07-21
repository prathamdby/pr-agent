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
  it("races only the hard deadline locally (no shouldCancelRun poller)", async () => {
    const turn: AgentRunnerTurn = { text: "ok" };
    const session = makeSession(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      return turn;
    });

    const result = await sendOrchestratorTurnOnceWithRetry({
      session,
      prompt: "hello",
      phase: "synthesis",
      shouldSend: () => true,
      deadlineAtMs: Date.now() + 60_000,
      now: () => Date.now(),
    });

    expect(result).toEqual({ ok: true, turn });
  });

  it("returns superseded when session.send rejects with superseded after abort", async () => {
    let rejectSend!: (error: unknown) => void;
    const abort = vi.fn(() => {
      rejectSend(
        new AppError({
          code: "review.orchestrator_send_superseded",
          message: "aborted",
          context: { reason: "superseded" },
        }),
      );
    });
    const session: AgentRunnerSession = {
      send: vi.fn(
        () =>
          new Promise<AgentRunnerTurn>((_resolve, reject) => {
            rejectSend = reject;
          }),
      ),
      restoreTools: vi.fn(),
      restrictToTools: vi.fn(),
      abort,
      dispose: vi.fn(async () => undefined),
    };

    const sendPromise = sendOrchestratorTurnOnceWithRetry({
      session,
      prompt: "hang",
      phase: "synthesis",
      shouldSend: () => true,
      deadlineAtMs: Date.now() + 60_000,
      now: () => Date.now(),
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    session.abort();

    const result = await sendPromise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("superseded");
    }
  });

  it("returns deadline when the hard deadline fires during send", async () => {
    let nowMs = 1_000;
    const session = makeSession(async () => {
      await new Promise<void>(() => undefined);
      return { text: "never" };
    });

    const resultPromise = sendOrchestratorTurnOnceWithRetry({
      session,
      prompt: "hang",
      phase: "synthesis",
      shouldSend: () => true,
      deadlineAtMs: 1_050,
      now: () => nowMs,
    });

    // Advance past deadline so the timer (50ms) fires.
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    nowMs = 2_000;

    const result = await resultPromise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("deadline");
    }
    expect(session.abort).toHaveBeenCalled();
  });
});
