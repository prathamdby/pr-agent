import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiSession } from "../src/agent/runtime/types.js";
import { makeTestConfig } from "./helpers/config.js";

type AttemptBehavior =
  | { readonly kind: "report"; readonly report: Record<string, unknown> }
  | { readonly kind: "error"; readonly error: Error }
  | { readonly kind: "pending_create"; readonly settleAfterMs: number }
  | { readonly kind: "pending_send"; readonly settleAfterMs: number }
  | { readonly kind: "no_report" }
  | { readonly kind: "pending" };

type TestSession = Pick<PiSession, "role" | "send" | "abort" | "dispose"> & {
  readonly send: ReturnType<typeof vi.fn>;
  readonly abort: ReturnType<typeof vi.fn>;
  readonly dispose: ReturnType<typeof vi.fn>;
};

const runnerMocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  behaviors: [] as AttemptBehavior[],
  sessions: [] as TestSession[],
}));

vi.mock("../src/agent/runtime/createFeatureSession.js", () => ({
  createFeaturePiSession: runnerMocks.createSession,
}));

import { resolveToolEventsContext } from "../src/agent/runtime/agentEventSink.js";
import { REVIEW_SPECIALIST_TOOL_NAMES } from "../src/review/orchestrator/specialistToolSet.js";
import { runSpecialist } from "../src/review/orchestrator/specialistRun.js";
import { stubLaneCatalog } from "./helpers/laneTools.js";

const finding = {
  severity: "P2",
  file: "src/example.ts",
  startLine: 7,
  endLine: 7,
  title: "Handle the missing value",
  detail: "The changed branch dereferences the missing value.",
  fixPrompt: "Guard the missing value before dereferencing it.",
};

const findingsReport = { status: "findings", findings: [finding] } as const;
const emptyReport = { status: "no_findings", findings: [] } as const;

function specialistArgs(overrides: Partial<Parameters<typeof runSpecialist>[0]> = {}) {
  return {
    cfg: makeTestConfig(),
    cwd: "/tmp/pr-agent-specialist-test",
    specialist: "correctness" as const,
    briefMessage: "Review this pull request.",
    workspaceTools: stubLaneCatalog(
      REVIEW_SPECIALIST_TOOL_NAMES.filter((name) => name !== "submit_findings_report"),
    ),
    timeoutMs: 10_000,
    shouldContinue: () => true,
    ...overrides,
  };
}

describe("runSpecialist", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runnerMocks.behaviors.length = 0;
    runnerMocks.sessions.length = 0;
    vi.spyOn(Math, "random").mockReturnValue(0);
    runnerMocks.createSession.mockImplementation(async (params) => {
      const behavior = runnerMocks.behaviors.shift();
      if (!behavior) throw new Error("missing specialist test behavior");
      if (behavior.kind === "pending_create") {
        const session: TestSession = {
          role: "specialist",
          send: vi.fn(async () => ({ text: "" })),
          abort: vi.fn(async () => undefined),
          dispose: vi.fn(async () => undefined),
        };
        runnerMocks.sessions.push(session);
        return new Promise<TestSession>((resolve) => {
          setTimeout(() => resolve(session), behavior.settleAfterMs);
        });
      }
      let rejectPending: ((error: Error) => void) | undefined;
      const abort = vi.fn(async () => {
        rejectPending?.(new Error("specialist session aborted"));
      });
      const session: TestSession = {
        role: "specialist",
        send: vi.fn(async () => {
          if (behavior.kind === "error") throw behavior.error;
          if (behavior.kind === "pending_send") {
            return new Promise<{ readonly text: string }>((resolve) => {
              setTimeout(() => resolve({ text: "" }), behavior.settleAfterMs);
            });
          }
          if (behavior.kind === "pending") {
            return new Promise<{ readonly text: string }>((_, reject) => {
              rejectPending = reject;
            });
          }
          if (behavior.kind === "no_report") return { text: "" };
          await params.executors.submit_findings_report(behavior.report);
          return { text: "" };
        }),
        abort,
        dispose: vi.fn(async () => undefined),
      };
      runnerMocks.sessions.push(session);
      return session;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns a valid findings report", async () => {
    runnerMocks.behaviors.push({ kind: "report", report: findingsReport });

    const outcome = await runSpecialist(specialistArgs());

    expect(outcome).toMatchObject({
      kind: "report",
      specialist: "correctness",
      report: findingsReport,
      durationMs: expect.any(Number),
    });
    expect(runnerMocks.sessions[0]?.send).toHaveBeenCalledWith("Review this pull request.", {
      maxToolRounds: 24,
      phase: "specialist",
      checkpointId: "specialist:specialist",
    });
    expect(runnerMocks.sessions[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it("keeps tool events context when specialist checkpoints are off", async () => {
    const durability = {
      pool: {} as never,
      workItemId: "wi-1",
      installationId: 7,
      owner: "acme",
      repo: "app",
      prNumber: 3,
    };
    runnerMocks.behaviors.push({ kind: "report", report: findingsReport });

    await runSpecialist(specialistArgs({ durability }));

    expect(runnerMocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        persistCheckpoints: false,
        eventsContext: resolveToolEventsContext(durability),
      }),
    );
  });

  it("repairs a single-object findings report at the parse seam", async () => {
    runnerMocks.behaviors.push({
      kind: "report",
      report: { status: "findings", findings: finding },
    });

    const outcome = await runSpecialist(specialistArgs());

    expect(outcome).toMatchObject({
      kind: "report",
      specialist: "correctness",
      report: findingsReport,
    });
  });

  it("returns empty for a valid no_findings report", async () => {
    runnerMocks.behaviors.push({ kind: "report", report: emptyReport });

    await expect(runSpecialist(specialistArgs())).resolves.toMatchObject({
      kind: "empty",
      specialist: "correctness",
      durationMs: expect.any(Number),
    });
  });

  it("uses one fresh-session retry after an ordinary failure", async () => {
    runnerMocks.behaviors.push(
      { kind: "error", error: new Error("provider disconnected") },
      { kind: "report", report: findingsReport },
    );

    const outcome = await runSpecialist(specialistArgs());

    expect(outcome.kind).toBe("report");
    expect(runnerMocks.createSession).toHaveBeenCalledTimes(2);
    expect(runnerMocks.sessions.every((session) => session.dispose.mock.calls.length === 1)).toBe(
      true,
    );
  });

  it("returns review.specialist_failed after two ordinary failures", async () => {
    runnerMocks.behaviors.push(
      { kind: "error", error: new Error("first ordinary failure") },
      { kind: "error", error: new Error("second ordinary failure") },
    );

    const outcome = await runSpecialist(specialistArgs());

    expect(outcome).toMatchObject({
      kind: "error",
      specialist: "correctness",
      error: {
        code: "review.specialist_failed",
        context: { classification: "unknown", attempts: 2 },
      },
    });
    expect(runnerMocks.createSession).toHaveBeenCalledTimes(2);
  });

  it("exhausts validation repair rounds when no report is submitted", async () => {
    runnerMocks.behaviors.push({ kind: "no_report" }, { kind: "no_report" });

    const outcome = await runSpecialist(specialistArgs());

    expect(outcome).toMatchObject({
      kind: "error",
      error: {
        code: "review.specialist_failed",
        context: { classification: "unknown", attempts: 2 },
      },
    });
    expect(runnerMocks.sessions).toHaveLength(2);
    expect(runnerMocks.sessions.every((session) => session.send.mock.calls.length === 4)).toBe(
      true,
    );
  });

  it("aborts the active session before disposal when the deadline expires", async () => {
    vi.useFakeTimers();
    runnerMocks.behaviors.push({ kind: "pending" });

    const outcomePromise = runSpecialist(specialistArgs({ timeoutMs: 100 }));
    await vi.runAllTimersAsync();
    const outcome = await outcomePromise;

    const session = runnerMocks.sessions[0];
    expect(outcome).toMatchObject({
      kind: "error",
      error: {
        code: "review.specialist_failed",
        context: { classification: "timeout", attempts: 1 },
      },
    });
    expect(session?.abort).toHaveBeenCalledTimes(1);
    expect(session?.dispose).toHaveBeenCalledTimes(1);
    expect(session?.abort.mock.invocationCallOrder[0]).toBeLessThan(
      session?.dispose.mock.invocationCallOrder[0] ?? Infinity,
    );
  });

  it("returns at the hard deadline and disposes after a late send settles", async () => {
    vi.useFakeTimers();
    runnerMocks.behaviors.push({ kind: "pending_send", settleAfterMs: 200 });
    let outcome: Awaited<ReturnType<typeof runSpecialist>> | undefined;

    void runSpecialist(specialistArgs({ timeoutMs: 100 })).then((result) => {
      outcome = result;
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(outcome).toMatchObject({
      kind: "error",
      error: {
        code: "review.specialist_failed",
        context: { classification: "timeout", attempts: 1 },
      },
    });
    expect(runnerMocks.sessions[0]?.abort).toHaveBeenCalledTimes(1);
    expect(runnerMocks.sessions[0]?.dispose).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);

    expect(runnerMocks.sessions[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it("returns at the hard deadline and cleans up a late session creation afterward", async () => {
    vi.useFakeTimers();
    runnerMocks.behaviors.push({ kind: "pending_create", settleAfterMs: 200 });
    let outcome: Awaited<ReturnType<typeof runSpecialist>> | undefined;

    void runSpecialist(specialistArgs({ timeoutMs: 100 })).then((result) => {
      outcome = result;
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(outcome).toMatchObject({
      kind: "error",
      error: {
        code: "review.specialist_failed",
        context: { classification: "timeout", attempts: 1 },
      },
    });
    expect(runnerMocks.sessions[0]?.dispose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(runnerMocks.sessions[0]?.abort).toHaveBeenCalledTimes(1);
    expect(runnerMocks.sessions[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it("preserves the ordinary retry after a rate limit failure", async () => {
    vi.useFakeTimers();
    runnerMocks.behaviors.push(
      { kind: "error", error: new Error("429 rate limit exceeded") },
      { kind: "error", error: new Error("provider disconnected") },
      { kind: "report", report: findingsReport },
    );

    const outcomePromise = runSpecialist(specialistArgs());
    await vi.runAllTimersAsync();
    const outcome = await outcomePromise;

    expect(outcome.kind).toBe("report");
    expect(runnerMocks.createSession).toHaveBeenCalledTimes(3);
  });

  it("never creates more than three sessions", async () => {
    vi.useFakeTimers();
    runnerMocks.behaviors.push(
      { kind: "error", error: new Error("429 rate limit exceeded") },
      { kind: "error", error: new Error("429 rate limit exceeded") },
      { kind: "error", error: new Error("429 rate limit exceeded") },
      { kind: "report", report: findingsReport },
    );

    const outcomePromise = runSpecialist(specialistArgs());
    await vi.runAllTimersAsync();
    const outcome = await outcomePromise;

    expect(outcome).toMatchObject({
      kind: "error",
      error: {
        code: "review.specialist_failed",
        context: { classification: "rate_limit", attempts: 3 },
      },
    });
    expect(runnerMocks.createSession).toHaveBeenCalledTimes(3);
    expect(runnerMocks.behaviors).toHaveLength(1);
  });

  it("aborts and disposes the active session when the external signal fires", async () => {
    runnerMocks.behaviors.push({ kind: "pending" });
    const controller = new AbortController();

    const outcomePromise = runSpecialist(specialistArgs({ signal: controller.signal }));
    await vi.waitFor(() => expect(runnerMocks.sessions[0]?.send).toHaveBeenCalledTimes(1));
    controller.abort();
    const outcome = await outcomePromise;

    expect(outcome).toMatchObject({
      kind: "error",
      error: { code: "review.specialist_failed", context: { attempts: 1 } },
    });
    expect(runnerMocks.sessions[0]?.abort).toHaveBeenCalledTimes(1);
    expect(runnerMocks.sessions[0]?.dispose).toHaveBeenCalledTimes(1);
  });
});
