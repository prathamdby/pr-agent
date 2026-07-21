import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SpecialistId,
  SpecialistOutcome,
} from "../src/review/orchestrator/specialistReport.js";
import { AppError } from "../src/errors/appError.js";
import {
  deferred,
  emptyOutcome,
  errorOutcome,
  expectSummaryFindings,
  finding,
  installOrchestratorSession,
  orchestratorBaseParams,
  reportOutcome,
  resetOrchestratorPublishMocks,
  submitDefaultBrief,
} from "./helpers/orchestratorRunHarness.js";

const mocks = vi.hoisted(() => ({
  runSpecialist: vi.fn(),
  publishFindingBatch: vi.fn(),
  publishReviewSummaryOnly: vi.fn(),
  upsertReviewSummaryComment: vi.fn(),
  tickProgressComment: vi.fn(),
  createSession: vi.fn(),
  isInstallationTokenNearExpiry: vi.fn((_expiresAtTs?: number) => false),
}));

vi.mock("../src/review/orchestrator/specialistRun.js", () => ({
  runSpecialist: (args: unknown) => mocks.runSpecialist(args),
}));

vi.mock("../src/review/publish/publishFindingBatch.js", () => ({
  publishFindingBatch: (findings: unknown, ctx: unknown) =>
    mocks.publishFindingBatch(findings, ctx),
}));

vi.mock("../src/review/publish/publishSummaryOnly.js", () => ({
  publishReviewSummaryOnly: (args: unknown) => mocks.publishReviewSummaryOnly(args),
}));

vi.mock("../src/github/reviewPublish.js", () => ({
  upsertReviewSummaryComment: (
    token: unknown,
    owner: unknown,
    repo: unknown,
    pr: unknown,
    body: unknown,
    sentinel: unknown,
    hint: unknown,
    expires: unknown,
  ) => mocks.upsertReviewSummaryComment(token, owner, repo, pr, body, sentinel, hint, expires),
}));

vi.mock("../src/review/orchestrator/stubTick.js", () => ({
  tickProgressComment: (args: unknown) => mocks.tickProgressComment(args),
}));

vi.mock("../src/github/installationTokenExpiry.js", () => ({
  isInstallationTokenNearExpiry: (expiresAtTs: number) =>
    mocks.isInstallationTokenNearExpiry(expiresAtTs),
  INSTALLATION_TOKEN_REFRESH_BUFFER_MS: 300_000,
}));

vi.mock("../src/agent/providers/index.js", () => ({
  resolveAgentRunnerProvider: () => ({ createSession: mocks.createSession }),
}));

import { runOrchestratedPrReview } from "../src/review/orchestrator/orchestratorRun.js";

const baseParams = orchestratorBaseParams;

describe("runOrchestratedPrReview (terminal races)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetOrchestratorPublishMocks(mocks);
  });

  it("superseded mid-pump aborts all sessions and skips summary", async () => {
    let continueGate = true;
    const security = deferred<SpecialistOutcome>();
    const pendingOthers = new Map<SpecialistId, ReturnType<typeof deferred<SpecialistOutcome>>>();

    mocks.runSpecialist.mockImplementation(async (args: { specialist: SpecialistId }) => {
      if (args.specialist === "security") return security.promise;
      const d = deferred<SpecialistOutcome>();
      pendingOthers.set(args.specialist, d);
      return d.promise;
    });

    const session = installOrchestratorSession(mocks, {
      onRecon: async (executors) => {
        await submitDefaultBrief(executors);
      },
      onJudgment: async () => {
        continueGate = false;
      },
    });

    const runPromise = runOrchestratedPrReview(
      baseParams({
        specialistDispatchStaggerMs: 0,
        shouldAbortPublish: async () => !continueGate,
        progressTick: { pool: {}, workItemId: "w", resourceKey: "rk" },
      }),
    );

    security.resolve(reportOutcome("security"));
    await vi.waitFor(() => expect(session.abort).toHaveBeenCalled());
    for (const [, d] of pendingOthers) {
      d.resolve(emptyOutcome("correctness"));
    }

    const result = await runPromise;
    expect(result.published).toBe(false);
    expect(result.publishSuperseded).toBe(true);
    expect(mocks.publishReviewSummaryOnly).not.toHaveBeenCalled();
    expect(session.abort).toHaveBeenCalled();
    expect(mocks.tickProgressComment).toHaveBeenCalledWith(
      expect.objectContaining({ runPhase: "superseded_rescheduled" }),
    );
  });

  it("pending synthesis send superseded by cheap shouldCancelRun skips summary and failure publish", async () => {
    let cancelRun = false;
    mocks.runSpecialist.mockImplementation(async (args: { specialist: SpecialistId }) =>
      emptyOutcome(args.specialist),
    );

    const session = installOrchestratorSession(mocks, {
      onRecon: async (executors) => {
        await submitDefaultBrief(executors);
      },
    });

    session.send.mockImplementation(async (prompt: string) => {
      if (
        prompt.includes("submit_specialist_brief") ||
        prompt.includes("Recon this pull request")
      ) {
        await submitDefaultBrief(session.executors);
        return { text: "recon done" };
      }
      cancelRun = true;
      await new Promise<void>(() => undefined);
      return { text: "never" };
    });

    const result = await runOrchestratedPrReview(
      baseParams({
        specialistDispatchStaggerMs: 0,
        shouldCancelRun: async () => cancelRun,
        shouldAbortPublish: async () => false,
        sleep: async (ms: number) => {
          await new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 5)));
        },
        progressTick: { pool: {}, workItemId: "w", resourceKey: "rk" },
      }),
    );

    expect(result.publishSuperseded).toBe(true);
    expect(result.published).toBe(false);
    expect(mocks.publishReviewSummaryOnly).not.toHaveBeenCalled();
    expect(mocks.upsertReviewSummaryComment).not.toHaveBeenCalled();
    expect(session.abort).toHaveBeenCalled();
    expect(mocks.tickProgressComment).toHaveBeenCalledWith(
      expect.objectContaining({ runPhase: "superseded_rescheduled" }),
    );
  });

  it("pending specialists: cheap shouldCancelRun aborts all without waiting for timeout and does not poll shouldAbortPublish repeatedly", async () => {
    let cancelRun = false;
    let cancelCalls = 0;
    let abortPublishCalls = 0;
    const startedAt = Date.now();

    mocks.runSpecialist.mockImplementation(
      async (args: { specialist: SpecialistId; signal?: AbortSignal; timeoutMs: number }) => {
        await new Promise<void>((resolve) => {
          if (args.signal?.aborted) {
            resolve();
            return;
          }
          args.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return {
          specialist: args.specialist,
          kind: "error" as const,
          error: new AppError({
            code: "review.specialist_failed",
            message: `${args.specialist} superseded`,
            context: { specialist: args.specialist, reason: "superseded" },
          }),
          durationMs: 1,
        };
      },
    );

    const session = installOrchestratorSession(mocks, {
      onRecon: async (executors) => {
        await submitDefaultBrief(executors);
      },
    });

    setTimeout(() => {
      cancelRun = true;
    }, 25);

    const result = await runOrchestratedPrReview(
      baseParams({
        specialistDispatchStaggerMs: 0,
        shouldCancelRun: async () => {
          cancelCalls += 1;
          return cancelRun;
        },
        shouldAbortPublish: async () => {
          abortPublishCalls += 1;
          return false;
        },
        sleep: async (ms: number) => {
          await new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 5)));
        },
        progressTick: { pool: {}, workItemId: "w", resourceKey: "rk" },
      }),
    );

    const elapsedMs = Date.now() - startedAt;
    expect(result.publishSuperseded).toBe(true);
    expect(result.published).toBe(false);
    expect(mocks.publishReviewSummaryOnly).not.toHaveBeenCalled();
    expect(session.abort).toHaveBeenCalled();
    expect(cancelCalls).toBeGreaterThan(0);
    // Full stale-head/publish gate only at explicit gates (post-recon), never on the 250ms poll.
    expect(abortPublishCalls).toBeLessThanOrEqual(2);
    // Must not wait out specialist timeouts (test cfg uses 50s).
    expect(elapsedMs).toBeLessThan(5_000);
  });

  it("deadline aborts pending specialists and publishes a degraded summary", async () => {
    let nowMs = 1_000;
    mocks.runSpecialist.mockImplementation(async (args: { specialist: SpecialistId }) => {
      if (args.specialist === "correctness") {
        return reportOutcome("correctness");
      }
      await Promise.resolve();
      return errorOutcome(args.specialist);
    });

    installOrchestratorSession(mocks, {
      onRecon: async (executors) => {
        await submitDefaultBrief(executors);
      },
      onJudgment: async (executors) => {
        nowMs = 100_000;
        await executors.publish_thread!({ findings: [finding("correctness")] });
      },
    });

    const result = await runOrchestratedPrReview(
      baseParams({
        now: () => nowMs,
        deadlineAtMs: 50_000,
        specialistDispatchStaggerMs: 0,
      }),
    );

    expect(result.published).toBe(true);
    expect(mocks.publishReviewSummaryOnly).toHaveBeenCalledWith(
      expect.objectContaining({
        partialCoverageNote: expect.stringContaining("Judgment degraded"),
      }),
    );
  });

  it("at deadline accumulates unjudged reports as summary-only without thread writes", async () => {
    let nowMs = 1_000;
    mocks.runSpecialist.mockImplementation(async (args: { specialist: SpecialistId }) => {
      if (args.specialist === "correctness") return reportOutcome("correctness");
      if (args.specialist === "security") return reportOutcome("security");
      return emptyOutcome(args.specialist);
    });

    installOrchestratorSession(mocks, {
      onRecon: async (executors) => {
        await submitDefaultBrief(executors);
        nowMs = 100_000;
      },
    });

    const result = await runOrchestratedPrReview(
      baseParams({
        now: () => nowMs,
        deadlineAtMs: 50_000,
        specialistDispatchStaggerMs: 0,
      }),
    );

    expect(result.published).toBe(true);
    expect(result.publishSuperseded).toBe(false);
    expect(mocks.publishFindingBatch).not.toHaveBeenCalled();
    expectSummaryFindings(mocks, ["correctness bug 1", "security bug 1"]);
  });

  it("aborts a hanging orchestrator send at the hard deadline and still publishes", async () => {
    let nowMs = 1_000;
    mocks.runSpecialist.mockImplementation(async (args: { specialist: SpecialistId }) =>
      emptyOutcome(args.specialist),
    );

    const session = installOrchestratorSession(mocks, {
      onRecon: async (executors) => {
        await submitDefaultBrief(executors);
      },
    });

    session.send.mockImplementation(async (prompt: string) => {
      if (
        prompt.includes("submit_specialist_brief") ||
        prompt.includes("Recon this pull request")
      ) {
        await submitDefaultBrief(session.executors);
        return { text: "recon done" };
      }
      await new Promise<void>((_resolve) => undefined);
      return { text: "never" };
    });

    const result = await runOrchestratedPrReview(
      baseParams({
        now: () => nowMs,
        deadlineAtMs: 1_500,
        specialistDispatchStaggerMs: 0,
        sleep: async (ms: number) => {
          nowMs += ms;
        },
      }),
    );

    expect(result.published).toBe(true);
    expect(session.abort).toHaveBeenCalled();
    expect(mocks.publishReviewSummaryOnly).toHaveBeenCalled();
    expect(result.publishSuperseded).toBe(false);
  });

  it("deadline after recon does not mark the run superseded or skip the summary", async () => {
    let nowMs = 10_000;
    mocks.runSpecialist.mockImplementation(async (args: { specialist: SpecialistId }) =>
      emptyOutcome(args.specialist),
    );

    installOrchestratorSession(mocks, {
      onRecon: async (executors) => {
        nowMs = 100_000;
        await submitDefaultBrief(executors);
      },
    });

    const result = await runOrchestratedPrReview(
      baseParams({
        now: () => nowMs,
        deadlineAtMs: 50_000,
        specialistDispatchStaggerMs: 0,
        progressTick: { pool: {}, workItemId: "w", resourceKey: "rk" },
      }),
    );

    expect(result.publishSuperseded).toBe(false);
    expect(result.published).toBe(true);
    expect(mocks.publishReviewSummaryOnly).toHaveBeenCalled();
    expect(mocks.tickProgressComment).not.toHaveBeenCalledWith(
      expect.objectContaining({ runPhase: "superseded_rescheduled" }),
    );
  });

  it("all four deadline specialist errors publish a deterministic summary, not a failure notice", async () => {
    mocks.runSpecialist.mockImplementation(async (args: { specialist: SpecialistId }) => ({
      specialist: args.specialist,
      kind: "error" as const,
      error: new AppError({
        code: "review.specialist_failed",
        message: `${args.specialist} deadline`,
        context: { specialist: args.specialist, reason: "deadline" },
      }),
      durationMs: 1,
    }));

    installOrchestratorSession(mocks, {
      onRecon: async (executors) => {
        await submitDefaultBrief(executors);
      },
    });

    const result = await runOrchestratedPrReview(baseParams({ specialistDispatchStaggerMs: 0 }));
    expect(result.published).toBe(true);
    expect(mocks.publishReviewSummaryOnly).toHaveBeenCalled();
    expect(mocks.upsertReviewSummaryComment).not.toHaveBeenCalled();
  });
});
