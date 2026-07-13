import { describe, expect, it, vi, beforeEach } from "vitest";
import * as evlog from "../src/evlog.js";
import { REVIEW_CANCELLATION_POLL_MS } from "../src/settings/index.js";
import { makeTestConfig } from "./helpers/config.js";
import { mockLocalPrWorkspace } from "./helpers/mockWorkspace.js";

vi.mock("../src/github/reviewPublish.js", () => ({
  createIssueComment: vi.fn(async () => ({
    id: 99,
    url: "https://example.com/issues/comments/99",
  })),
  upsertReviewSummaryComment: vi.fn(async () => ({ id: 99, updated: true })),
}));

type ReviewExecutor = (args: Record<string, unknown>) => Promise<unknown>;

const reviewRunMocks = vi.hoisted(() => {
  const state: {
    capturedExecutors: Record<string, ReviewExecutor>;
    capturedSystemPrompt: string;
    capturedSignal?: AbortSignal;
  } = {
    capturedExecutors: {},
    capturedSystemPrompt: "",
  };
  const sendMock = vi.fn(async () => ({ text: "analysis without submitReview" }));
  const cancelMock = vi.fn(async () => undefined);
  const createSessionMock = vi.fn(
    async (params: {
      systemPrompt: string;
      executors: Record<string, ReviewExecutor>;
      signal?: AbortSignal;
    }) => {
      state.capturedSystemPrompt = params.systemPrompt;
      state.capturedExecutors = params.executors;
      state.capturedSignal = params.signal;
      return {
        send: sendMock,
        restrictToTools: vi.fn(),
        restoreTools: vi.fn(),
        cancel: cancelMock,
        dispose: vi.fn(async () => undefined),
      };
    },
  );
  return { state, sendMock, cancelMock, createSessionMock };
});

const reviewEnsembleMocks = vi.hoisted(() => ({
  runReviewerEnsemble: vi.fn(),
  validateHighRiskFindings: vi.fn(),
  buildSynthesisContext: vi.fn(),
}));

vi.mock("../src/agent/providers/pi/index.js", () => ({
  piAgentRunnerProvider: {
    createSession: reviewRunMocks.createSessionMock,
  },
}));

vi.mock("../src/review/run/reviewEnsemble.js", () => ({
  runReviewerEnsemble: reviewEnsembleMocks.runReviewerEnsemble,
  validateHighRiskFindings: reviewEnsembleMocks.validateHighRiskFindings,
  buildSynthesisContext: reviewEnsembleMocks.buildSynthesisContext,
}));

import { upsertReviewSummaryComment } from "../src/github/reviewPublish.js";
import { buildOrchestratorSystemPrompt } from "../src/review/prompts/reviewOrchestratorPrompt.js";
import { runFullPrReview } from "../src/review/run/reviewRun.js";

const cfg = makeTestConfig({
  maxToolRounds: 2,
  reviewConcurrency: 1,
  askConcurrency: 3,
  enableReviewLabelsEffort: false,
});

const farFutureTokenExpiry = Date.now() + 3_600_000;

const defaultReports = [
  {
    reviewer: "correctness" as const,
    coverage: "test",
    findings: [],
    residualRisks: [],
    testingGaps: [],
  },
  {
    reviewer: "security" as const,
    coverage: "test",
    findings: [],
    residualRisks: [],
    testingGaps: [],
  },
];

function reviewParams(
  overrides: Partial<Parameters<typeof runFullPrReview>[0]> = {},
): Parameters<typeof runFullPrReview>[0] {
  return {
    cfg,
    token: "t",
    tokenExpiresAtTs: farFutureTokenExpiry,
    tokenTtlMs: 3_600_000,
    owner: "o",
    repo: "r",
    prNumber: 1,
    headSha: "sha",
    workspace: mockLocalPrWorkspace(),
    ...overrides,
  };
}

describe("runFullPrReview mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reviewEnsembleMocks.runReviewerEnsemble.mockResolvedValue({
      reports: defaultReports,
      failed: [],
      selected: ["correctness", "security"],
      omitted: [],
    });
    reviewEnsembleMocks.validateHighRiskFindings.mockImplementation(async ({ reports }) => ({
      reports,
      truncatedCandidates: 0,
    }));
    reviewEnsembleMocks.buildSynthesisContext.mockReturnValue("synthesize");
    reviewRunMocks.sendMock.mockImplementation(async () => ({
      text: "analysis without submitReview",
    }));
  });

  it("requires finite tokenExpiresAtTs", async () => {
    await expect(runFullPrReview(reviewParams({ tokenExpiresAtTs: NaN }))).rejects.toThrow(
      /tokenExpiresAtTs/,
    );
  });

  it("selects the Review orchestrator system prompt by default", async () => {
    await runFullPrReview(
      reviewParams({
        cfg: { ...cfg, maxReviewPublishAttempts: 1, maxToolRounds: 1 },
      }),
    );

    expect(reviewRunMocks.state.capturedSystemPrompt).toBe(buildOrchestratorSystemPrompt());
  });

  it.each(["correctness", "security"] as const)(
    "fails before validation when required %s coverage is unavailable",
    async (reviewer) => {
      reviewEnsembleMocks.runReviewerEnsemble.mockResolvedValueOnce({
        reports: defaultReports.filter((item) => item.reviewer !== reviewer),
        failed: [reviewer],
        selected: ["correctness", "security"],
        omitted: [],
      });

      await expect(runFullPrReview(reviewParams())).rejects.toThrow(
        "Required review coverage did not complete",
      );

      expect(reviewEnsembleMocks.validateHighRiskFindings).not.toHaveBeenCalled();
      expect(reviewEnsembleMocks.buildSynthesisContext).not.toHaveBeenCalled();
      expect(reviewRunMocks.createSessionMock).not.toHaveBeenCalled();
      expect(upsertReviewSummaryComment).not.toHaveBeenCalled();
    },
  );

  it("passes transformed validation reports into synthesis", async () => {
    const candidate = {
      severity: "P1" as const,
      file: "src/a.ts",
      startLine: 1,
      endLine: 1,
      title: "Candidate",
      detail: "Candidate detail",
      fixPrompt: "Fix it",
      confidence: 5,
      category: "bug" as const,
      evidence: "Evidence",
    };
    reviewEnsembleMocks.runReviewerEnsemble.mockResolvedValueOnce({
      reports: [{ ...defaultReports[0], findings: [candidate] }, defaultReports[1]],
      failed: [],
      selected: ["correctness", "security"],
      omitted: [],
    });
    reviewEnsembleMocks.validateHighRiskFindings.mockResolvedValueOnce({
      reports: defaultReports,
      truncatedCandidates: 0,
    });

    await runFullPrReview(
      reviewParams({ cfg: { ...cfg, maxReviewPublishAttempts: 1, maxToolRounds: 1 } }),
    );

    expect(reviewEnsembleMocks.buildSynthesisContext).toHaveBeenCalledWith(
      expect.objectContaining({ reports: defaultReports }),
    );
  });
});

describe("runFullPrReview publish retries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reviewEnsembleMocks.runReviewerEnsemble.mockResolvedValue({
      reports: defaultReports,
      failed: [],
      selected: ["correctness", "security"],
      omitted: [],
    });
    reviewEnsembleMocks.validateHighRiskFindings.mockImplementation(async ({ reports }) => ({
      reports,
      truncatedCandidates: 0,
    }));
    reviewEnsembleMocks.buildSynthesisContext.mockReturnValue("synthesize");
    reviewRunMocks.sendMock.mockImplementation(async () => ({
      text: "analysis without submitReview",
    }));
  });

  it("retries submitReview up to maxReviewPublishAttempts before failing", async () => {
    const infoSpy = vi.spyOn(evlog, "logInfo");

    const result = await runFullPrReview(reviewParams());

    expect(result.published).toBe(false);
    expect(result.publishAttempts).toBe(3);
    expect(infoSpy).toHaveBeenCalledWith(
      "review_publish_retry",
      expect.objectContaining({ attempt: 2, maxAttempts: 3 }),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      "review_publish_retry",
      expect.objectContaining({ attempt: 3, maxAttempts: 3 }),
    );
  });

  it("posts a deterministic fallback comment when publish is exhausted", async () => {
    const result = await runFullPrReview(reviewParams());

    expect(result.published).toBe(false);
    const body = vi.mocked(upsertReviewSummaryComment).mock.calls.at(-1)?.[4] as string;
    expect(body).toContain("## PR Agent Review");
    expect(body).toContain("Review did not finish");
    expect(body).toContain("/review");
    expect(body).not.toMatch(/structured publish/i);
    expect(body).not.toMatch(/server logs/i);
    expect(body).not.toMatch(/\d+\/\d+ attempt/i);
    expect(body).not.toContain("analysis without submitReview");
    expect(body).not.toContain("Line could not be resolved");
  });

  it("emits review_run_completed with ambient metrics snapshot", async () => {
    evlog.initEvlog("info", { silent: true, suppressDrainWarning: true });
    const infoSpy = vi.spyOn(evlog, "logInfo");
    await evlog.runWithOperationLogger({ method: "JOB", path: "/review" }, async () => {
      await runFullPrReview(
        reviewParams({
          cfg: { ...cfg, maxReviewPublishAttempts: 1, maxToolRounds: 1 },
        }),
      );
    });
    expect(infoSpy).toHaveBeenCalledWith(
      "review_run_completed",
      expect.objectContaining({
        provider: cfg.agentProvider,
        model: cfg.piModel,
        mode: "review",
        published: false,
      }),
    );
    infoSpy.mockRestore();
  });

  it("aborts before fan-out and does not post fallback when already cancelled", async () => {
    const result = await runFullPrReview(
      reviewParams({
        shouldAbortPublish: async () => true,
      }),
    );

    expect(result.published).toBe(false);
    expect(result.publishAttempts).toBe(0);
    expect(result.publishSuperseded).toBe(true);
    expect(reviewEnsembleMocks.runReviewerEnsemble).not.toHaveBeenCalled();
    expect(upsertReviewSummaryComment).not.toHaveBeenCalled();
  });

  it("aborts the shared signal when cancellation flips during reviewer fan-out", async () => {
    vi.useFakeTimers();
    let checks = 0;
    let ensembleSignal: AbortSignal | undefined;
    let markEnsembleStarted: (() => void) | undefined;
    const ensembleStarted = new Promise<void>((resolve) => {
      markEnsembleStarted = resolve;
    });
    reviewEnsembleMocks.runReviewerEnsemble.mockImplementationOnce(
      async (params: { signal?: AbortSignal }) => {
        ensembleSignal = params.signal;
        markEnsembleStarted?.();
        return new Promise((resolve) => {
          params.signal?.addEventListener(
            "abort",
            () => resolve({ reports: defaultReports, failed: [] }),
            { once: true },
          );
        });
      },
    );

    try {
      const resultPromise = runFullPrReview(
        reviewParams({
          shouldAbortPublish: async () => {
            checks += 1;
            return checks >= 2;
          },
        }),
      );
      await ensembleStarted;
      await vi.advanceTimersByTimeAsync(REVIEW_CANCELLATION_POLL_MS);
      const result = await resultPromise;

      expect(ensembleSignal?.aborted).toBe(true);
      expect(result.publishSuperseded).toBe(true);
      expect(reviewEnsembleMocks.validateHighRiskFindings).not.toHaveBeenCalled();
      expect(reviewRunMocks.createSessionMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the orchestrator session when cancellation flips before synthesis", async () => {
    let checks = 0;

    const result = await runFullPrReview(
      reviewParams({
        shouldAbortPublish: async () => {
          checks += 1;
          return checks >= 4;
        },
      }),
    );

    expect(result.publishSuperseded).toBe(true);
    expect(reviewRunMocks.cancelMock).toHaveBeenCalledTimes(1);
    expect(reviewRunMocks.state.capturedSignal?.aborted).toBe(true);
    expect(reviewRunMocks.sendMock).not.toHaveBeenCalled();
  });
});
