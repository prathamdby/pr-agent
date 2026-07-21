import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SpecialistId,
  SpecialistOutcome,
} from "../src/review/orchestrator/specialistReport.js";
import { makeTestConfig } from "./helpers/config.js";
import {
  deferred,
  emptyOutcome,
  errorOutcome,
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

describe("runOrchestratedPrReview (core path)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetOrchestratorPublishMocks(mocks);
  });

  it("happy path: judgment order follows completion order and summary publishes last", async () => {
    const order: string[] = [];
    const correctness = deferred<SpecialistOutcome>();
    const security = deferred<SpecialistOutcome>();
    const quality = deferred<SpecialistOutcome>();
    const tests = deferred<SpecialistOutcome>();
    const byId: Record<SpecialistId, ReturnType<typeof deferred<SpecialistOutcome>>> = {
      correctness,
      security,
      quality,
      tests,
    };

    mocks.runSpecialist.mockImplementation(async (args: { specialist: SpecialistId }) => {
      return byId[args.specialist].promise;
    });

    const session = installOrchestratorSession(mocks, {
      onRecon: async (executors) => {
        await submitDefaultBrief(executors, {
          prIntent: "Ship orchestrator",
          architectureNotes: "V2",
          fileMap: "src/a.ts",
        });
      },
      onJudgment: async (executors, prompt) => {
        order.push(`judge:${/Specialist `(\w+)`/.exec(prompt)?.[1] ?? "?"}`);
        await executors.publish_thread!({ findings: [finding("judged")] });
      },
      onSynthesis: async (executors) => {
        order.push("summary");
        await executors.publish_summary!({
          prCharacter: "Good",
          estimatedEffort: 2,
          relevantTests: "partial",
          securityConcerns: null,
          followUps: [],
          mergeVerdict: { score: 4, rationale: "ok on this pass" },
        });
      },
    });

    const runPromise = runOrchestratedPrReview(baseParams({ specialistDispatchStaggerMs: 0 }));

    security.resolve(reportOutcome("security"));
    await vi.waitFor(() => expect(order).toEqual(["judge:security"]));
    quality.resolve(reportOutcome("quality"));
    await vi.waitFor(() => expect(order).toEqual(["judge:security", "judge:quality"]));
    correctness.resolve(reportOutcome("correctness"));
    await vi.waitFor(() =>
      expect(order).toEqual(["judge:security", "judge:quality", "judge:correctness"]),
    );
    tests.resolve(reportOutcome("tests"));

    const result = await runPromise;
    expect(result.published).toBe(true);
    expect(order).toEqual([
      "judge:security",
      "judge:quality",
      "judge:correctness",
      "judge:tests",
      "summary",
    ]);
    expect(session.restoreTools).toHaveBeenCalled();
    expect(session.restrictToTools).toHaveBeenCalled();
    const restoreCount = session.restoreTools.mock.calls.length;
    const restrictCount = session.restrictToTools.mock.calls.length;
    expect(restoreCount).toBeGreaterThanOrEqual(restrictCount);
  });

  it("skips judgment for an explicit empty specialist", async () => {
    mocks.runSpecialist.mockImplementation(async (args: { specialist: SpecialistId }) => {
      if (args.specialist === "quality") return emptyOutcome("quality");
      return reportOutcome(args.specialist);
    });

    const judgmentSpecialists: string[] = [];
    installOrchestratorSession(mocks, {
      onRecon: async (executors) => {
        await submitDefaultBrief(executors);
      },
      onJudgment: async (executors, prompt) => {
        judgmentSpecialists.push(/Specialist `(\w+)`/.exec(prompt)?.[1] ?? "?");
        await executors.publish_thread!({ findings: [finding("x")] });
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

    const result = await runOrchestratedPrReview(baseParams());
    expect(result.published).toBe(true);
    expect(judgmentSpecialists).toEqual(["correctness", "security", "tests"]);
    expect(judgmentSpecialists).not.toContain("quality");
  });

  it("partial specialist error notes coverage and forces coveragePartial on summary", async () => {
    mocks.runSpecialist.mockImplementation(async (args: { specialist: SpecialistId }) => {
      if (args.specialist === "security") return errorOutcome("security");
      return reportOutcome(args.specialist);
    });

    installOrchestratorSession(mocks, {
      onRecon: async (executors) => {
        await submitDefaultBrief(executors);
      },
      onJudgment: async (executors) => {
        await executors.publish_thread!({ findings: [finding("x")] });
      },
      onSynthesis: async (executors) => {
        await executors.publish_summary!({
          prCharacter: "partial",
          estimatedEffort: 2,
          relevantTests: "no",
          securityConcerns: null,
          followUps: [],
        });
      },
    });

    const result = await runOrchestratedPrReview(baseParams());
    expect(result.published).toBe(true);
    expect(mocks.publishReviewSummaryOnly).toHaveBeenCalledWith(
      expect.objectContaining({
        coveragePartial: true,
        partialCoverageNote: expect.stringContaining("security"),
      }),
    );
  });

  it("all four specialist errors publish failure notice and no summary", async () => {
    mocks.runSpecialist.mockImplementation(async (args: { specialist: SpecialistId }) =>
      errorOutcome(args.specialist),
    );

    installOrchestratorSession(mocks, {
      onRecon: async (executors) => {
        await submitDefaultBrief(executors);
      },
    });

    const result = await runOrchestratedPrReview(baseParams());
    expect(result.published).toBe(false);
    expect(mocks.upsertReviewSummaryComment).toHaveBeenCalled();
    expect(mocks.publishReviewSummaryOnly).not.toHaveBeenCalled();
  });

  it("all four empty specialists still synthesize a successful summary", async () => {
    mocks.runSpecialist.mockImplementation(async (args: { specialist: SpecialistId }) =>
      emptyOutcome(args.specialist),
    );

    installOrchestratorSession(mocks, {
      onRecon: async (executors) => {
        await submitDefaultBrief(executors);
      },
      onSynthesis: async (executors) => {
        await executors.publish_summary!({
          prCharacter: "No findings on this pass.",
          estimatedEffort: 1,
          relevantTests: "no",
          securityConcerns: null,
          followUps: [],
        });
      },
    });

    const result = await runOrchestratedPrReview(baseParams());
    expect(result.published).toBe(true);
    expect(mocks.publishFindingBatch).not.toHaveBeenCalled();
    expect(mocks.publishReviewSummaryOnly).toHaveBeenCalled();
  });

  it("passes previously accepted findings into judgment prompts (same-file hints)", async () => {
    const prompts: string[] = [];
    const correctness = deferred<SpecialistOutcome>();
    const security = deferred<SpecialistOutcome>();
    mocks.runSpecialist.mockImplementation(async (args: { specialist: SpecialistId }) => {
      if (args.specialist === "correctness") return correctness.promise;
      if (args.specialist === "security") return security.promise;
      return emptyOutcome(args.specialist);
    });

    installOrchestratorSession(mocks, {
      onRecon: async (executors) => {
        await submitDefaultBrief(executors);
      },
      onJudgment: async (executors, prompt) => {
        prompts.push(prompt);
        await executors.publish_thread!({
          findings: [finding(prompt.includes("security") ? "security" : "correctness")],
        });
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

    const runPromise = runOrchestratedPrReview(baseParams({ specialistDispatchStaggerMs: 0 }));
    correctness.resolve(reportOutcome("correctness", [finding("correctness")]));
    await vi.waitFor(() => expect(prompts.length).toBe(1));
    security.resolve(
      reportOutcome("security", [
        { ...finding("correctness"), title: "paraphrase of correctness bug" },
      ]),
    );
    const result = await runPromise;
    expect(result.published).toBe(true);
    expect(prompts.some((p) => p.includes("Already published"))).toBe(true);
  });

  it("treats empty findings publish_thread as a successful call", async () => {
    mocks.runSpecialist.mockImplementation(async (args: { specialist: SpecialistId }) => {
      if (args.specialist === "correctness") return reportOutcome("correctness");
      return emptyOutcome(args.specialist);
    });

    installOrchestratorSession(mocks, {
      onRecon: async (executors) => {
        await submitDefaultBrief(executors);
      },
      onJudgment: async (executors) => {
        await executors.publish_thread!({ findings: [] });
      },
      onSynthesis: async (executors) => {
        await executors.publish_summary!({
          prCharacter: "empty ok",
          estimatedEffort: 1,
          relevantTests: "no",
          securityConcerns: null,
          followUps: [],
        });
      },
    });

    const result = await runOrchestratedPrReview(baseParams());
    expect(result.published).toBe(true);
    expect(mocks.publishFindingBatch).toHaveBeenCalledTimes(1);
    expect(mocks.publishFindingBatch).toHaveBeenCalledWith([], expect.any(Object));
  });

  it("dispatches all four specialists with the same remaining/4 timeout", async () => {
    const timeouts: number[] = [];
    mocks.runSpecialist.mockImplementation(
      async (args: { specialist: SpecialistId; timeoutMs: number }) => {
        timeouts.push(args.timeoutMs);
        return emptyOutcome(args.specialist);
      },
    );

    installOrchestratorSession(mocks, {
      onRecon: async (executors) => {
        await submitDefaultBrief(executors);
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

    const nowMs = 1_000;
    await runOrchestratedPrReview(
      baseParams({
        now: () => nowMs,
        deadlineAtMs: nowMs + 40_000,
        specialistDispatchStaggerMs: 0,
        cfg: makeTestConfig({
          features: { ...makeTestConfig().features, reviewLabels: "off", commitStatus: false },
          queueExpireInSeconds: 100,
          reviewSpecialistTimeoutMs: 900_000,
        }),
      }),
    );

    expect(timeouts).toHaveLength(4);
    expect(new Set(timeouts).size).toBe(1);
    expect(timeouts[0]).toBe(10_000);
  });
});
