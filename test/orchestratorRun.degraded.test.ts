import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpecialistId } from "../src/review/orchestrator/specialistReport.js";
import { JUDGMENT_DEGRADED_NOTE } from "../src/settings/index.js";
import * as evlog from "../src/evlog.js";
import {
  emptyOutcome,
  finding,
  installOrchestratorSession,
  orchestratorBaseParams,
  orchestratorFarFuture,
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

describe("runOrchestratedPrReview (degraded / resume)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetOrchestratorPublishMocks(mocks);
  });

  it("judgment send throwing twice degrades to deterministic thread + summary", async () => {
    mocks.runSpecialist.mockImplementation(async (args: { specialist: SpecialistId }) => {
      if (args.specialist === "correctness") return reportOutcome("correctness");
      return emptyOutcome(args.specialist);
    });

    installOrchestratorSession(mocks, {
      onRecon: async (executors) => {
        await submitDefaultBrief(executors);
      },
      judgmentThrows: 2,
    });

    const result = await runOrchestratedPrReview(baseParams());
    expect(result.published).toBe(true);
    expect(mocks.publishFindingBatch).toHaveBeenCalled();
    expect(mocks.publishReviewSummaryOnly).toHaveBeenCalledWith(
      expect.objectContaining({
        partialCoverageNote: expect.stringContaining(JUDGMENT_DEGRADED_NOTE.slice(0, 20)),
      }),
    );
  });

  it("falls back to a deterministic brief when recon never submits one", async () => {
    const warnSpy = vi.spyOn(evlog, "logWarn");
    mocks.runSpecialist.mockImplementation(async (args: { specialist: SpecialistId }) =>
      emptyOutcome(args.specialist),
    );

    installOrchestratorSession(mocks, {
      onSynthesis: async (executors) => {
        await executors.publish_summary!({
          prCharacter: "fallback brief run",
          estimatedEffort: 1,
          relevantTests: "no",
          securityConcerns: null,
          followUps: [],
        });
      },
    });

    const result = await runOrchestratedPrReview(baseParams());
    expect(result.published).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith("review_brief_fallback", expect.any(Object));
    expect(mocks.runSpecialist).toHaveBeenCalledWith(
      expect.objectContaining({
        briefMessage: expect.stringContaining("Deterministic brief fallback"),
      }),
    );
  });

  it("refreshes the installation token when near expiry before publish", async () => {
    mocks.isInstallationTokenNearExpiry.mockReturnValue(true);
    const refresh = vi.fn(async () => ({
      token: "fresh",
      expiresAtTs: orchestratorFarFuture,
    }));

    mocks.runSpecialist.mockImplementation(async (args: { specialist: SpecialistId }) => {
      if (args.specialist === "correctness") return reportOutcome("correctness");
      return emptyOutcome(args.specialist);
    });

    installOrchestratorSession(mocks, {
      onRecon: async (executors) => {
        await submitDefaultBrief(executors);
      },
      onJudgment: async (executors) => {
        await executors.publish_thread!({ findings: [finding("correctness")] });
      },
      onSynthesis: async (executors) => {
        await executors.publish_summary!({
          prCharacter: "ok",
          estimatedEffort: 1,
          relevantTests: "no",
          securityConcerns: null,
          followUps: [],
        });
      },
    });

    await runOrchestratedPrReview(
      baseParams({
        refreshInstallationToken: refresh,
        tokenExpiresAtTs: Date.now() + 1_000,
      }),
    );

    expect(refresh).toHaveBeenCalled();
  });

  it("retains budget-exhausted findings as summary-only via the thread tool", async () => {
    mocks.runSpecialist.mockImplementation(async (args: { specialist: SpecialistId }) => {
      if (args.specialist === "correctness") return reportOutcome("correctness");
      return emptyOutcome(args.specialist);
    });

    installOrchestratorSession(mocks, {
      onRecon: async (executors) => {
        await submitDefaultBrief(executors);
      },
      onJudgment: async (executors) => {
        const result = await executors.publish_thread!({ findings: [finding("correctness")] });
        expect(result).toEqual(expect.objectContaining({ kind: "budget_exhausted" }));
      },
      onSynthesis: async (executors) => {
        await executors.publish_summary!({
          prCharacter: "budget",
          estimatedEffort: 1,
          relevantTests: "no",
          securityConcerns: null,
          followUps: [],
        });
      },
    });

    mocks.publishFindingBatch.mockImplementation(
      async (findings: unknown[], ctx: { runState: { acceptedFindings: unknown[] } }) => {
        ctx.runState.acceptedFindings.push(...(findings as unknown[]));
        return { kind: "budget_exhausted" };
      },
    );

    const result = await runOrchestratedPrReview(baseParams());
    expect(result.published).toBe(true);
    expect(mocks.publishReviewSummaryOnly).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          findings: expect.arrayContaining([
            expect.objectContaining({ title: "correctness bug 1" }),
          ]),
        }),
      }),
    );
  });

  it("degrades a judgment that returns text without calling publish_thread", async () => {
    mocks.runSpecialist.mockImplementation(async (args: { specialist: SpecialistId }) => {
      if (args.specialist === "correctness") return reportOutcome("correctness");
      return emptyOutcome(args.specialist);
    });

    installOrchestratorSession(mocks, {
      onRecon: async (executors) => {
        await submitDefaultBrief(executors);
      },
      onJudgment: async () => {
        // intentionally no publish_thread call
      },
    });

    const result = await runOrchestratedPrReview(baseParams());
    expect(result.published).toBe(true);
    expect(mocks.publishFindingBatch).toHaveBeenCalled();
    expect(mocks.publishReviewSummaryOnly).toHaveBeenCalled();
  });

  it("recon send failing twice skips later orchestrator sends and publishes deterministically", async () => {
    mocks.runSpecialist.mockImplementation(async (args: { specialist: SpecialistId }) => {
      if (args.specialist === "correctness") return reportOutcome("correctness");
      return emptyOutcome(args.specialist);
    });

    const session = installOrchestratorSession(mocks, {});
    session.send.mockImplementation(async () => {
      throw new Error("recon provider dead");
    });

    const result = await runOrchestratedPrReview(baseParams({ specialistDispatchStaggerMs: 0 }));
    expect(result.published).toBe(true);
    expect(mocks.publishFindingBatch).toHaveBeenCalled();
    expect(mocks.publishReviewSummaryOnly).toHaveBeenCalled();
    expect(session.send).toHaveBeenCalledTimes(2);
  });

  it("returns idempotently when the current work item summary is already published", async () => {
    const result = await runOrchestratedPrReview(
      baseParams({
        initialPublishState: { published: true, postedInlineCount: 2, batchCount: 2 },
      }),
    );
    expect(result.published).toBe(true);
    expect(result.publishSuperseded).toBe(false);
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.runSpecialist).not.toHaveBeenCalled();
  });

  it("seeds batchCount from resume state so MAX_THREAD_PUBLISH_CALLS is not exceeded", async () => {
    mocks.runSpecialist.mockImplementation(async (args: { specialist: SpecialistId }) => {
      if (args.specialist === "correctness") return reportOutcome("correctness");
      return emptyOutcome(args.specialist);
    });

    installOrchestratorSession(mocks, {
      onRecon: async (executors) => {
        await submitDefaultBrief(executors);
      },
      onJudgment: async (executors) => {
        await executors.publish_thread!({ findings: [finding("correctness")] });
      },
      onSynthesis: async (executors) => {
        await executors.publish_summary!({
          prCharacter: "ok",
          estimatedEffort: 1,
          relevantTests: "no",
          securityConcerns: null,
          followUps: [],
        });
      },
    });

    await runOrchestratedPrReview(
      baseParams({
        initialPublishState: { published: false, postedInlineCount: 3, batchCount: 7 },
      }),
    );

    expect(mocks.publishFindingBatch).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        runState: expect.objectContaining({ batchCount: 8 }),
      }),
    );
  });
});
