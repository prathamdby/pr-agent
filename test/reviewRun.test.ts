import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Config } from "../src/config.js";
import * as evlog from "../src/evlog.js";

vi.mock("../src/github/reviewPublish.js", () => ({
  createIssueComment: vi.fn(async () => ({
    id: 99,
    url: "https://example.com/issues/comments/99",
  })),
  upsertReviewSummaryComment: vi.fn(async () => ({ id: 99, updated: true })),
}));

const sendMock = vi.fn(async () => ({ text: "analysis without submitReview" }));
type ReviewExecutor = (args: Record<string, unknown>) => Promise<unknown>;
let capturedExecutors: Record<string, ReviewExecutor> = {};
const createSessionMock = vi.fn(
  async (params: { systemPrompt: string; executors: Record<string, ReviewExecutor> }) => {
    capturedSystemPrompt = params.systemPrompt;
    capturedExecutors = params.executors;
    return {
      send: sendMock,
      restrictToTools: vi.fn(),
      restoreTools: vi.fn(),
      dispose: vi.fn(async () => undefined),
    };
  },
);

let capturedSystemPrompt = "";

vi.mock("../src/agent/providers/pi/index.js", () => ({
  piAgentRunnerProvider: {
    createSession: (...args: unknown[]) => createSessionMock(...args),
  },
}));

import { upsertReviewSummaryComment } from "../src/github/reviewPublish.js";
import { automatedSecuritySystemPrompt } from "../src/agent/securityPrompt.js";
import { automatedQualitySystemPrompt } from "../src/agent/qualityPrompt.js";
import { runFullPrReview } from "../src/review/reviewRun.js";

const cfg = {
  port: 0,
  githubAppId: "1",
  githubAppPrivateKey: "k",
  webhookSecret: "s",
  agentProvider: "pi",
  piProvider: "openai",
  piModel: "gpt-4o-mini",
  maxToolRounds: 2,
  maxReviewPublishAttempts: 3,
  maxReviewPublishCalls: 2,
  reviewConcurrency: 1,
  askConcurrency: 3,
  maxAskToolRounds: 12,
  maxAskFinalizeRounds: 2,
  webhookTimeoutMs: 10_000,
  logLevel: "error",
  enableReviewLabelsEffort: false,
  enableReviewLabelsSecurity: false,
  maxPrFilesListed: 300,
  maxPrFilesPatchBytes: 500_000,
  reviewInjectAnchorMenu: true,
  reviewRequireDiffCacheBeforeSubmit: true,
  reviewAnchorMenuMaxFiles: 40,
  reviewAnchorMenuMaxRangesPerFile: 20,
  context7ApiKey: "",
} satisfies Config;

const farFutureTokenExpiry = Date.now() + 3_600_000;

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
    ...overrides,
  };
}

describe("runFullPrReview mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendMock.mockImplementation(async () => ({ text: "analysis without submitReview" }));
  });

  it("requires finite tokenExpiresAtTs", async () => {
    await expect(runFullPrReview(reviewParams({ tokenExpiresAtTs: NaN }))).rejects.toThrow(
      /tokenExpiresAtTs/,
    );
  });

  it("selects security system prompt when mode is review-security", async () => {
    await runFullPrReview(
      reviewParams({
        cfg: { ...cfg, maxReviewPublishAttempts: 1, maxToolRounds: 1 },
        mode: "review-security",
      }),
    );

    expect(capturedSystemPrompt).toBe(automatedSecuritySystemPrompt);
  });

  it("selects quality system prompt when mode is review-quality", async () => {
    await runFullPrReview(
      reviewParams({
        cfg: { ...cfg, maxReviewPublishAttempts: 1, maxToolRounds: 1 },
        mode: "review-quality",
      }),
    );

    expect(capturedSystemPrompt).toBe(automatedQualitySystemPrompt);
  });

  it("selects general system prompt by default", async () => {
    await runFullPrReview(
      reviewParams({ cfg: { ...cfg, maxReviewPublishAttempts: 1, maxToolRounds: 1 } }),
    );

    expect(capturedSystemPrompt).toContain("senior staff software engineer");
    expect(capturedSystemPrompt).not.toBe(automatedSecuritySystemPrompt);
  });

  it("uses security fallback heading when security publish is exhausted", async () => {
    await runFullPrReview(reviewParams({ mode: "review-security" }));

    const body = vi.mocked(upsertReviewSummaryComment).mock.calls.at(-1)?.[4] as string;
    expect(body).toContain("## PR Agent Security Review");
    expect(body).toContain("Review did not finish");
    expect(body).not.toMatch(/structured publish/i);
    expect(body).not.toMatch(/server logs/i);
    expect(body).not.toContain("analysis without submitReview");
  });
});

describe("runFullPrReview publish retries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendMock.mockImplementation(async () => ({ text: "analysis without submitReview" }));
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
        reviewParams({ cfg: { ...cfg, maxReviewPublishAttempts: 1, maxToolRounds: 1 } }),
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

  it("aborts early and does not post fallback comment if shouldAbortPublish returns true", async () => {
    sendMock.mockImplementation(async () => {
      try {
        await capturedExecutors.submitReview({
          prCharacter: "Does things.",
          findings: [],
          estimatedEffort: 1,
          relevantTests: "no",
          securityConcerns: null,
          followUps: [],
        });
      } catch {
        // Expected
      }
      return { text: "aborted review attempt" };
    });

    const result = await runFullPrReview(
      reviewParams({
        cfg: { ...cfg, reviewRequireDiffCacheBeforeSubmit: false },
        shouldAbortPublish: async () => true,
      }),
    );

    expect(result.published).toBe(false);
    expect(result.publishAttempts).toBe(1);
    expect(result.publishSuperseded).toBe(true);
    expect(upsertReviewSummaryComment).not.toHaveBeenCalled();
  });
});
