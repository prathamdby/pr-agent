import { expect, vi } from "vitest";
import { AppError } from "../../src/errors/appError.js";
import type { AgentRunnerToolExecutor } from "../../src/agent/providers/interface.js";
import type {
  SpecialistId,
  SpecialistOutcome,
} from "../../src/review/orchestrator/specialistReport.js";
import { makeTestConfig } from "./config.js";
import { mockLocalPrWorkspace } from "./mockWorkspace.js";

export const orchestratorTestCfg = makeTestConfig({
  features: { ...makeTestConfig().features, reviewLabels: "off", commitStatus: false },
  queueExpireInSeconds: 100,
  reviewSpecialistTimeoutMs: 50_000,
});

export const orchestratorFarFuture = Date.now() + 3_600_000;

export type OrchestratorRunMocks = {
  // vitest Mock instances — kept loose so hoisted fixtures stay assignable.
  runSpecialist: ReturnType<typeof vi.fn> & ((...args: never[]) => unknown);
  publishFindingBatch: ReturnType<typeof vi.fn> & ((...args: never[]) => unknown);
  publishReviewSummaryOnly: ReturnType<typeof vi.fn> & ((...args: never[]) => unknown);
  upsertReviewSummaryComment: ReturnType<typeof vi.fn> & ((...args: never[]) => unknown);
  tickProgressComment: ReturnType<typeof vi.fn> & ((...args: never[]) => unknown);
  createSession: ReturnType<typeof vi.fn> & ((...args: never[]) => unknown);
  isInstallationTokenNearExpiry: ReturnType<typeof vi.fn> & ((...args: never[]) => unknown);
};

export function finding(specialist: string, n = 1) {
  return {
    severity: "P1" as const,
    file: `src/${specialist}.ts`,
    startLine: n,
    endLine: n,
    title: `${specialist} bug ${n}`,
    detail: `detail for ${specialist}`,
    fixPrompt: `fix ${specialist}`,
  };
}

export function reportOutcome(
  specialist: SpecialistId,
  findings = [finding(specialist)],
): Extract<SpecialistOutcome, { kind: "report" }> {
  return {
    specialist,
    kind: "report",
    report: { status: "findings", findings },
    durationMs: 1,
  };
}

export function emptyOutcome(specialist: SpecialistId): SpecialistOutcome {
  return { specialist, kind: "empty", durationMs: 1 };
}

export function errorOutcome(specialist: SpecialistId): SpecialistOutcome {
  return {
    specialist,
    kind: "error",
    error: new AppError({ code: "review.specialist_failed", message: `${specialist} died` }),
    durationMs: 1,
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

export type SessionHooks = {
  restoreTools: ReturnType<typeof vi.fn>;
  restrictToTools: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  executors: Record<string, AgentRunnerToolExecutor>;
};

export function installOrchestratorSession(
  mocks: Pick<OrchestratorRunMocks, "createSession">,
  script: {
    onRecon?: (executors: Record<string, AgentRunnerToolExecutor>) => Promise<void>;
    onJudgment?: (
      executors: Record<string, AgentRunnerToolExecutor>,
      prompt: string,
      callIndex: number,
    ) => Promise<void>;
    onSynthesis?: (
      executors: Record<string, AgentRunnerToolExecutor>,
      prompt: string,
    ) => Promise<void>;
    judgmentThrows?: number;
    synthesisThrows?: number;
  },
): SessionHooks {
  const restoreTools = vi.fn();
  const restrictToTools = vi.fn();
  const pendingAbortRejects = new Set<(error: unknown) => void>();
  const abort = vi.fn(() => {
    const error = new AppError({
      code: "agent.session_aborted",
      message: "Orchestrator session aborted",
      context: { reason: "superseded" },
    });
    for (const reject of pendingAbortRejects) {
      reject(error);
    }
    pendingAbortRejects.clear();
  });
  const dispose = vi.fn(async () => undefined);
  let executors: Record<string, AgentRunnerToolExecutor> = {};
  let judgmentCalls = 0;
  let judgmentFailuresLeft = script.judgmentThrows ?? 0;
  let synthesisFailuresLeft = script.synthesisThrows ?? 0;

  const runSendBody = async (prompt: string) => {
    if (prompt.includes("submit_specialist_brief") || prompt.includes("Recon this pull request")) {
      await script.onRecon?.(executors);
      return { text: "recon done" };
    }
    if (prompt.includes("Specialist `") && prompt.includes("reported")) {
      if (judgmentFailuresLeft > 0) {
        judgmentFailuresLeft -= 1;
        throw new Error("judgment provider boom");
      }
      judgmentCalls += 1;
      await script.onJudgment?.(executors, prompt, judgmentCalls);
      return { text: "judged" };
    }
    if (prompt.includes("publish_summary") || prompt.includes("Synthesize the final")) {
      if (synthesisFailuresLeft > 0) {
        synthesisFailuresLeft -= 1;
        throw new Error("synthesis provider boom");
      }
      await script.onSynthesis?.(executors, prompt);
      return { text: "synthesized" };
    }
    if (executors.publish_thread) {
      await script.onJudgment?.(executors, prompt, judgmentCalls);
    } else if (executors.publish_summary) {
      await script.onSynthesis?.(executors, prompt);
    } else if (executors.submit_specialist_brief) {
      await script.onRecon?.(executors);
    }
    return { text: "ok" };
  };

  const send = vi.fn(async (prompt: string) => {
    let rejectAbort!: (error: unknown) => void;
    const abortRace = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
      pendingAbortRejects.add(reject);
    });
    try {
      return await Promise.race([runSendBody(prompt), abortRace]);
    } finally {
      pendingAbortRejects.delete(rejectAbort);
    }
  });

  mocks.createSession.mockImplementation(
    async (params: { executors: Record<string, AgentRunnerToolExecutor> }) => {
      executors = params.executors;
      return {
        send,
        restoreTools,
        restrictToTools: (
          tools: unknown[],
          nextExecutors: Record<string, AgentRunnerToolExecutor>,
        ) => {
          restrictToTools(tools, nextExecutors);
          executors = nextExecutors;
        },
        abort,
        dispose,
      };
    },
  );

  return {
    restoreTools,
    restrictToTools,
    abort,
    dispose,
    send,
    get executors() {
      return executors;
    },
  };
}

export function orchestratorBaseParams(overrides: Record<string, unknown> = {}) {
  return {
    cfg: orchestratorTestCfg,
    token: "tok",
    tokenExpiresAtTs: orchestratorFarFuture,
    tokenTtlMs: 3_600_000,
    owner: "o",
    repo: "r",
    prNumber: 1,
    headSha: "sha",
    workspace: mockLocalPrWorkspace(),
    prTitle: "Add orchestrator",
    prBody: "Implements Chunk E.",
    reviewSource: "slash" as const,
    sleep: async () => undefined,
    ...overrides,
  };
}

export function resetOrchestratorPublishMocks(mocks: OrchestratorRunMocks): void {
  mocks.publishFindingBatch.mockImplementation(
    async (
      findings: unknown[],
      ctx: {
        runState: { acceptedFindings: unknown[]; postedInlineCount: number; batchCount: number };
      },
    ) => {
      const list = findings as unknown[];
      ctx.runState.acceptedFindings.push(...list);
      ctx.runState.postedInlineCount += list.length;
      ctx.runState.batchCount += 1;
      return { kind: "published", reviewId: 1, posted: list.length, suppressed: 0, dropped: 0 };
    },
  );
  mocks.publishReviewSummaryOnly.mockResolvedValue({ summaryCommentId: 99 });
  mocks.upsertReviewSummaryComment.mockResolvedValue({ id: 99, updated: true });
  mocks.tickProgressComment.mockResolvedValue(undefined);
  mocks.isInstallationTokenNearExpiry.mockReturnValue(false);
}

/** Standard brief payload used by most orchestrator run scripts. */
export const defaultBriefArgs = {
  prIntent: "intent",
  architectureNotes: "",
  riskAreas: [] as string[],
  fileMap: "f",
  specialistFocus: { correctness: "c", security: "s", quality: "q", tests: "t" },
};

export async function submitDefaultBrief(
  executors: Record<string, AgentRunnerToolExecutor>,
  overrides: Partial<typeof defaultBriefArgs> & {
    specialistFocus?: typeof defaultBriefArgs.specialistFocus;
  } = {},
): Promise<void> {
  await executors.submit_specialist_brief!({
    ...defaultBriefArgs,
    ...overrides,
    specialistFocus: overrides.specialistFocus ?? defaultBriefArgs.specialistFocus,
  });
}

export function expectSummaryFindings(
  mocks: Pick<OrchestratorRunMocks, "publishReviewSummaryOnly">,
  titles: string[],
): void {
  expect(mocks.publishReviewSummaryOnly).toHaveBeenCalledWith(
    expect.objectContaining({
      payload: expect.objectContaining({
        findings: expect.arrayContaining(titles.map((title) => expect.objectContaining({ title }))),
      }),
    }),
  );
}
