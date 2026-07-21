import { describe, expect, it, vi } from "vitest";
import type { AgentRunnerToolExecutor } from "../src/agent/providers/interface.js";

const providerState = vi.hoisted(() => ({
  createSession: undefined as unknown as (params: {
    executors: Record<string, AgentRunnerToolExecutor>;
  }) => Promise<unknown>,
}));

vi.mock("../src/agent/providers/index.js", () => ({
  resolveAgentRunnerProvider: () => ({ createSession: providerState.createSession }),
}));

import { runSpecialist } from "../src/review/orchestrator/specialistRun.js";
import { makeTestConfig } from "./helpers/config.js";

const cfg = makeTestConfig();

function makeFinding(): Record<string, unknown> {
  return {
    severity: "P1",
    file: "src/handler.ts",
    startLine: 10,
    endLine: 10,
    title: "Missing await on promise",
    detail: "The handler returns before the async work completes.",
    fixPrompt: "Await the promise before returning so errors propagate.",
  };
}

type SessionSend = (input: {
  executors: Record<string, AgentRunnerToolExecutor>;
  prompt: string;
}) => Promise<{ text: string }>;

type SessionBehavior = {
  send: SessionSend;
};

function scriptedProvider(behaviors: SessionBehavior[]) {
  const abortSpies: Array<ReturnType<typeof vi.fn>> = [];
  const disposeSpies: Array<ReturnType<typeof vi.fn>> = [];
  let calls = 0;
  const createSession = vi.fn(
    async (params: { executors: Record<string, AgentRunnerToolExecutor> }) => {
      const behavior = behaviors[calls] ?? behaviors[behaviors.length - 1];
      calls += 1;
      const abort = vi.fn();
      const dispose = vi.fn(async () => undefined);
      abortSpies.push(abort);
      disposeSpies.push(dispose);
      return {
        send: vi.fn(async (prompt: string) =>
          behavior.send({ executors: params.executors, prompt }),
        ),
        restrictToTools: vi.fn(),
        restoreTools: vi.fn(),
        abort,
        dispose,
      };
    },
  );
  return {
    createSession,
    abortSpies,
    disposeSpies,
    sessionsCreated: () => calls,
  };
}

const baseArgs = {
  cfg,
  cwd: "/tmp/checkout",
  specialist: "correctness" as const,
  briefMessage: "Investigate the billing retry path.",
  workspaceTools: { piTools: [], executors: {} },
  timeoutMs: 5_000,
};

describe("runSpecialist", () => {
  it("returns a findings report when the specialist submits one", async () => {
    const provider = scriptedProvider([
      {
        send: async ({ executors }) => {
          await executors.submit_findings_report({ status: "findings", findings: [makeFinding()] });
          return { text: "" };
        },
      },
    ]);
    providerState.createSession = provider.createSession;

    const outcome = await runSpecialist({
      ...baseArgs,
      shouldContinue: () => true,
      sleep: async () => undefined,
    });

    expect(outcome.kind).toBe("report");
    if (outcome.kind === "report") {
      expect(outcome.report.status).toBe("findings");
      expect(outcome.report.findings).toHaveLength(1);
      expect(outcome.specialist).toBe("correctness");
      expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
    }
    expect(provider.sessionsCreated()).toBe(1);
    expect(provider.disposeSpies[0]).toHaveBeenCalledTimes(1);
  });

  it("maps an explicit no_findings report to an empty outcome", async () => {
    const provider = scriptedProvider([
      {
        send: async ({ executors }) => {
          await executors.submit_findings_report({ status: "no_findings" });
          return { text: "" };
        },
      },
    ]);
    providerState.createSession = provider.createSession;

    const outcome = await runSpecialist({
      ...baseArgs,
      shouldContinue: () => true,
      sleep: async () => undefined,
    });

    expect(outcome.kind).toBe("empty");
    expect(provider.sessionsCreated()).toBe(1);
  });

  it("retries once with a fresh session after a non-transient failure", async () => {
    const provider = scriptedProvider([
      {
        send: async () => {
          throw new Error("provider exploded");
        },
      },
      {
        send: async ({ executors }) => {
          await executors.submit_findings_report({ status: "findings", findings: [makeFinding()] });
          return { text: "" };
        },
      },
    ]);
    providerState.createSession = provider.createSession;

    const outcome = await runSpecialist({
      ...baseArgs,
      shouldContinue: () => true,
      sleep: async () => undefined,
    });

    expect(outcome.kind).toBe("report");
    expect(provider.sessionsCreated()).toBe(2);
    expect(provider.disposeSpies).toHaveLength(2);
    for (const dispose of provider.disposeSpies) expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("returns review.specialist_failed after both attempts fail", async () => {
    const provider = scriptedProvider([
      {
        send: async () => {
          throw new Error("boom one");
        },
      },
      {
        send: async () => {
          throw new Error("boom two");
        },
      },
    ]);
    providerState.createSession = provider.createSession;

    const outcome = await runSpecialist({
      ...baseArgs,
      shouldContinue: () => true,
      sleep: async () => undefined,
    });

    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.error.code).toBe("review.specialist_failed");
      expect(outcome.error.context.specialist).toBe("correctness");
    }
    expect(provider.sessionsCreated()).toBe(2);
  });

  it("retries classified rate_limit failures with backoff without consuming the fresh-session retry", async () => {
    const sleep = vi.fn(async () => undefined);
    const provider = scriptedProvider([
      {
        send: async () => {
          throw new Error("429 rate limit exceeded");
        },
      },
      {
        send: async ({ executors }) => {
          await executors.submit_findings_report({ status: "findings", findings: [makeFinding()] });
          return { text: "" };
        },
      },
    ]);
    providerState.createSession = provider.createSession;

    const outcome = await runSpecialist({
      ...baseArgs,
      shouldContinue: () => true,
      sleep,
    });

    expect(outcome.kind).toBe("report");
    expect(provider.sessionsCreated()).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("caps total attempts at 3 for repeated transient failures", async () => {
    const sleep = vi.fn(async () => undefined);
    const provider = scriptedProvider([
      {
        send: async () => {
          throw new Error("429 too many requests");
        },
      },
    ]);
    providerState.createSession = provider.createSession;

    const outcome = await runSpecialist({
      ...baseArgs,
      shouldContinue: () => true,
      sleep,
    });

    expect(outcome.kind).toBe("error");
    expect(provider.sessionsCreated()).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("aborts then disposes the session when an attempt times out", async () => {
    const sleep = vi.fn(async () => undefined);
    const provider = scriptedProvider([{ send: () => new Promise<{ text: string }>(() => {}) }]);
    providerState.createSession = provider.createSession;

    const outcome = await runSpecialist({
      ...baseArgs,
      timeoutMs: 20,
      shouldContinue: () => true,
      sleep,
    });

    expect(outcome.kind).toBe("error");
    expect(provider.sessionsCreated()).toBe(3);
    for (const abort of provider.abortSpies) expect(abort).toHaveBeenCalled();
    for (const dispose of provider.disposeSpies) expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch when already superseded", async () => {
    const provider = scriptedProvider([
      {
        send: async ({ executors }) => {
          await executors.submit_findings_report({ status: "findings", findings: [makeFinding()] });
          return { text: "" };
        },
      },
    ]);
    providerState.createSession = provider.createSession;

    const outcome = await runSpecialist({
      ...baseArgs,
      shouldContinue: () => false,
      sleep: async () => undefined,
    });

    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.error.context.reason).toBe("superseded");
    }
    expect(provider.sessionsCreated()).toBe(0);
  });

  it("stops retrying once the caller deadline has passed", async () => {
    let clock = 1_000;
    const provider = scriptedProvider([
      {
        send: async () => {
          clock = 2_000;
          throw new Error("boom");
        },
      },
    ]);
    providerState.createSession = provider.createSession;

    const outcome = await runSpecialist({
      ...baseArgs,
      shouldContinue: () => true,
      sleep: async () => undefined,
      deadlineAtMs: 1_500,
      now: () => clock,
    });

    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.error.context.reason).toBe("deadline");
    }
    expect(provider.sessionsCreated()).toBe(1);
  });

  it("aborts and disposes the in-flight session when the external signal fires, without retrying", async () => {
    const abort = vi.fn();
    const dispose = vi.fn(async () => undefined);
    let created = 0;
    const createSession = vi.fn(async () => {
      created += 1;
      let rejectSend: (error: Error) => void = () => undefined;
      return {
        send: vi.fn(
          () =>
            new Promise<{ text: string }>((_resolve, reject) => {
              rejectSend = reject;
            }),
        ),
        restrictToTools: vi.fn(),
        restoreTools: vi.fn(),
        abort: vi.fn(() => {
          abort();
          rejectSend(new Error("aborted"));
        }),
        dispose,
      };
    });
    providerState.createSession = createSession;

    const controller = new AbortController();
    let live = true;
    const outcomePromise = runSpecialist({
      ...baseArgs,
      timeoutMs: 10_000,
      shouldContinue: () => live,
      sleep: async () => undefined,
      signal: controller.signal,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    live = false;
    controller.abort();

    const outcome = await outcomePromise;
    expect(outcome.kind).toBe("error");
    expect(abort).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(created).toBe(1);
  }, 1_000);

  it("caps transient backoff to the deadline and returns a deadline failure without redispatching", async () => {
    const sleep = vi.fn(async () => undefined);
    const provider = scriptedProvider([
      {
        send: async () => {
          throw new Error("429 rate limit exceeded");
        },
      },
    ]);
    providerState.createSession = provider.createSession;

    const outcome = await runSpecialist({
      ...baseArgs,
      shouldContinue: () => true,
      sleep,
      deadlineAtMs: 1_500,
      now: () => 1_000,
    });

    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.error.context.reason).toBe("deadline");
    }
    expect(provider.sessionsCreated()).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("runs validation repair rounds when the first submit is invalid", async () => {
    let sendCount = 0;
    const provider = scriptedProvider([
      {
        send: async ({ executors }) => {
          sendCount += 1;
          if (sendCount === 1) {
            await executors.submit_findings_report({ status: "findings", findings: [] });
            return { text: "no report yet" };
          }
          await executors.submit_findings_report({ status: "findings", findings: [makeFinding()] });
          return { text: "" };
        },
      },
    ]);
    providerState.createSession = provider.createSession;

    const outcome = await runSpecialist({
      ...baseArgs,
      shouldContinue: () => true,
      sleep: async () => undefined,
    });

    expect(outcome.kind).toBe("report");
    expect(provider.sessionsCreated()).toBe(1);
    expect(sendCount).toBeGreaterThanOrEqual(2);
  });
});
