import { describe, expect, it, vi } from "vitest";
import { AppError } from "../src/errors/appError.js";
import type { AgentRunnerSession, AgentRunnerTurn } from "../src/agent/providers/interface.js";
import {
  isOrchestratorSendDegradation,
  sendOrchestratorTurnOnceWithRetry,
  type OrchestratorSendResult,
} from "../src/review/orchestrator/orchestratorSend.js";

function makeSession(sendImpl: AgentRunnerSession["send"]): AgentRunnerSession {
  return {
    send: sendImpl,
    restoreTools: vi.fn(),
    restrictToTools: vi.fn(),
    abort: vi.fn(),
    dispose: vi.fn(async () => undefined),
  };
}

describe("isOrchestratorSendDegradation", () => {
  it.each([
    { reason: "failed" as const, expected: true },
    { reason: "deadline" as const, expected: false },
    { reason: "superseded" as const, expected: false },
    { reason: "skipped" as const, expected: false },
  ])("reason=$reason → $expected", ({ reason, expected }) => {
    const result: OrchestratorSendResult = {
      ok: false,
      reason,
      error: new AppError({
        code: `review.orchestrator_send_${reason}`,
        message: reason,
        context: { reason },
      }),
    };
    expect(isOrchestratorSendDegradation(result)).toBe(expected);
  });

  it("is false for ok sends", () => {
    expect(isOrchestratorSendDegradation({ ok: true, turn: { text: "ok" } })).toBe(false);
  });
});

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
          code: "agent.session_aborted",
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

  it("aborts the session immediately when the deadline already passed", async () => {
    const send = vi.fn(async () => ({ text: "never" }));
    const session = makeSession(send);

    const result = await sendOrchestratorTurnOnceWithRetry({
      session,
      prompt: "too late",
      phase: "judgment",
      shouldSend: () => true,
      deadlineAtMs: 1_000,
      now: () => 1_000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("deadline");
    }
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });
});
