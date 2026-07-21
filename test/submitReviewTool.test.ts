import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as evlog from "../src/evlog.js";
import { AppError } from "../src/errors/appError.js";
import {
  buildSubmitReviewTool,
  createSubmitReviewState,
} from "../src/review/publish/submitReviewTool.js";
import {
  SECURITY_REVIEW_SUMMARY_SENTINEL,
  QUALITY_REVIEW_SUMMARY_SENTINEL,
  TESTS_REVIEW_SUMMARY_SENTINEL,
} from "../src/review/reviewSchema.js";
import {
  createCachedPrDiffIndex,
  ingestListPullRequestFilesResult,
} from "../src/review/placement/reviewDiffIndex.js";
import {
  initReviewRunMetrics,
  snapshotReviewRunMetrics,
} from "../src/review/run/reviewRunMetrics.js";
import { REVIEW_DIFF_CACHE_REQUIRED_MESSAGE } from "../src/settings/index.js";
import { makeTestConfig } from "./helpers/config.js";

const settingsOverrides: { maxReviewPublishCalls?: number } = {};
vi.mock("../src/settings/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/settings/index.js")>();
  return {
    ...actual,
    get MAX_REVIEW_PUBLISH_CALLS() {
      return settingsOverrides.maxReviewPublishCalls ?? actual.MAX_REVIEW_PUBLISH_CALLS;
    },
  };
});

vi.mock("../src/review/publish/publishReview.js", () => ({
  publishReview: vi.fn(async () => undefined),
}));

import { publishReview } from "../src/review/publish/publishReview.js";

const cfg = makeTestConfig({
  port: 3000,
  reviewConcurrency: 1,
  askConcurrency: 3,
  logLevel: "info",
});

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    prCharacter: "Does things.",
    findings: [],
    estimatedEffort: 1,
    relevantTests: "no" as const,
    securityConcerns: null,
    followUps: [],
    ...overrides,
  };
}

function finding(overrides: Record<string, unknown> = {}) {
  return {
    severity: "P1" as const,
    file: "a.ts",
    startLine: 99,
    endLine: 99,
    title: "Finding",
    detail: "d",
    fixPrompt: "fix",
    ...overrides,
  };
}

describe("submitReview tool", () => {
  afterEach(() => {
    delete settingsOverrides.maxReviewPublishCalls;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(publishReview).mockResolvedValue(undefined);
  });

  it("ignores duplicate submitReview after publish", async () => {
    const state = createSubmitReviewState();
    const { executor } = buildSubmitReviewTool({
      cfg,
      token: "tok",
      ctx: { owner: "o", repo: "r", prNumber: 1, headSha: "sha", hasDescriptionAgentBlock: false },
      state,
    });

    const valid = validPayload();

    await executor(valid);
    expect(publishReview).toHaveBeenCalledTimes(1);
    await executor(valid);
    expect(publishReview).toHaveBeenCalledTimes(1);
  });

  it("sets lastValidationError on malformed payload", async () => {
    const warnSpy = vi.spyOn(evlog, "logWarn");
    const state = createSubmitReviewState();
    const { executor } = buildSubmitReviewTool({
      cfg,
      token: "tok",
      ctx: { owner: "o", repo: "r", prNumber: 1, headSha: "sha", hasDescriptionAgentBlock: false },
      state,
    });

    await expect(executor({ prCharacter: "x" })).rejects.toThrow(
      /ReviewPayload validation failed/i,
    );
    expect(state.lastValidationError).toBeTruthy();
    expect(state.published).toBe(false);
    expect(publishReview).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("caps valid publish executions at MAX_REVIEW_PUBLISH_CALLS", async () => {
    settingsOverrides.maxReviewPublishCalls = 1;
    vi.mocked(publishReview).mockRejectedValue(new Error("publish failed"));
    const state = createSubmitReviewState();
    const { executor } = buildSubmitReviewTool({
      cfg,
      token: "tok",
      ctx: { owner: "o", repo: "r", prNumber: 1, headSha: "sha", hasDescriptionAgentBlock: false },
      state,
    });
    const valid = validPayload();

    await expect(executor(valid)).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("review.publish_exhausted");
      expect((error as Error).message).toMatch(/publish budget exhausted/i);
      return true;
    });
    expect(publishReview).toHaveBeenCalledTimes(1);
    expect(state.publishCallsExhausted).toBe(true);
  });

  it("uses review.publish_failed when publish budget remains", async () => {
    settingsOverrides.maxReviewPublishCalls = 2;
    vi.mocked(publishReview).mockRejectedValue(new Error("publish failed"));
    const state = createSubmitReviewState();
    const { executor } = buildSubmitReviewTool({
      cfg,
      token: "tok",
      ctx: { owner: "o", repo: "r", prNumber: 1, headSha: "sha", hasDescriptionAgentBlock: false },
      state,
    });
    const valid = validPayload();

    await expect(executor(valid)).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("review.publish_failed");
      expect((error as AppError).cause).toBeInstanceOf(Error);
      return true;
    });
    expect(state.publishCallsExhausted).toBe(false);
  });

  it("treats abort-check failures as superseded publish", async () => {
    const state = createSubmitReviewState();
    const { executor } = buildSubmitReviewTool({
      cfg,
      token: "tok",
      ctx: { owner: "o", repo: "r", prNumber: 1, headSha: "sha", hasDescriptionAgentBlock: false },
      state,
      shouldAbortPublish: async () => {
        throw new Error("db unavailable");
      },
    });
    const valid = validPayload();

    await expect(executor(valid)).rejects.toThrow(/superseded or cancelled/i);
    expect(publishReview).not.toHaveBeenCalled();
    expect(state.publishCallCount).toBe(0);
    expect(state.publishSuperseded).toBe(true);
  });

  it("sets publishSuperseded when shouldAbortPublish returns true", async () => {
    const state = createSubmitReviewState();
    const { executor } = buildSubmitReviewTool({
      cfg,
      token: "tok",
      ctx: { owner: "o", repo: "r", prNumber: 1, headSha: "sha", hasDescriptionAgentBlock: false },
      state,
      canEnforceDiffCacheBeforeSubmit: () => false,
      shouldAbortPublish: async () => true,
    });
    const valid = validPayload();

    await expect(executor(valid)).rejects.toThrow(/superseded or cancelled/i);
    expect(state.publishSuperseded).toBe(true);
    expect(publishReview).not.toHaveBeenCalled();
  });

  it("mentions the security summary sentinel in the tool description", () => {
    const { piTool } = buildSubmitReviewTool({
      cfg,
      token: "tok",
      ctx: { owner: "o", repo: "r", prNumber: 1, headSha: "sha", hasDescriptionAgentBlock: false },
      mode: "review-security",
      state: createSubmitReviewState(),
    });
    expect(piTool.description).toContain(SECURITY_REVIEW_SUMMARY_SENTINEL);
  });

  it("mentions the quality summary sentinel in the tool description", () => {
    const { piTool } = buildSubmitReviewTool({
      cfg,
      token: "tok",
      ctx: { owner: "o", repo: "r", prNumber: 1, headSha: "sha", hasDescriptionAgentBlock: false },
      mode: "review-quality",
      state: createSubmitReviewState(),
    });
    expect(piTool.description).toContain(QUALITY_REVIEW_SUMMARY_SENTINEL);
  });

  it("mentions the tests summary sentinel in the tool description", () => {
    const { piTool } = buildSubmitReviewTool({
      cfg,
      token: "tok",
      ctx: { owner: "o", repo: "r", prNumber: 1, headSha: "sha", hasDescriptionAgentBlock: false },
      mode: "review-tests",
      state: createSubmitReviewState(),
    });
    expect(piTool.description).toContain(TESTS_REVIEW_SUMMARY_SENTINEL);
  });

  it("blocks submit when listPullRequestFiles was not ingested", async () => {
    evlog.initEvlog("info", { silent: true, suppressDrainWarning: true });
    const valid = validPayload();
    await evlog.runWithOperationLogger({ method: "JOB", path: "/test" }, async () => {
      initReviewRunMetrics({
        provider: "openai",
        model: "gpt-4o-mini",
        mode: "review",
      });
      const state = createSubmitReviewState();
      const { executor } = buildSubmitReviewTool({
        cfg,
        token: "tok",
        ctx: {
          owner: "o",
          repo: "r",
          prNumber: 1,
          headSha: "sha",
          hasDescriptionAgentBlock: false,
        },
        state,
        cachedDiffIndex: createCachedPrDiffIndex(),
      });
      await expect(executor(valid)).rejects.toThrow(REVIEW_DIFF_CACHE_REQUIRED_MESSAGE);
      expect(snapshotReviewRunMetrics()?.diffCacheEmptyAtFirstSubmit).toBe(true);
      expect(publishReview).not.toHaveBeenCalled();
    });
  });

  it("allows submit when diff cache enforcement is waived", async () => {
    const state = createSubmitReviewState();
    const index = createCachedPrDiffIndex();
    const { executor } = buildSubmitReviewTool({
      cfg,
      token: "tok",
      ctx: { owner: "o", repo: "r", prNumber: 1, headSha: "sha", hasDescriptionAgentBlock: false },
      state,
      cachedDiffIndex: index,
      canEnforceDiffCacheBeforeSubmit: () => false,
    });
    const valid = validPayload();
    await executor(valid);
    expect(publishReview).toHaveBeenCalledTimes(1);
  });

  it("allows submit with invalid anchors when enforcement is waived", async () => {
    const state = createSubmitReviewState();
    const index = createCachedPrDiffIndex();
    ingestListPullRequestFilesResult(index, {
      files: [{ filename: "a.ts", patch: ["@@ -1,1 +1,2 @@", " x", "+y"].join("\n") }],
    });
    const { executor } = buildSubmitReviewTool({
      cfg,
      token: "tok",
      ctx: { owner: "o", repo: "r", prNumber: 1, headSha: "sha", hasDescriptionAgentBlock: false },
      state,
      cachedDiffIndex: index,
      canEnforceDiffCacheBeforeSubmit: () => false,
    });
    const payload = validPayload({
      findings: [finding({ title: "Bad anchor" })],
    });
    await executor(payload);
    expect(publishReview).toHaveBeenCalledTimes(1);
  });

  it("allows submit when diff cache is ingested but has no files", async () => {
    const state = createSubmitReviewState();
    const index = createCachedPrDiffIndex();
    ingestListPullRequestFilesResult(index, { files: [] });
    const { executor } = buildSubmitReviewTool({
      cfg,
      token: "tok",
      ctx: { owner: "o", repo: "r", prNumber: 1, headSha: "sha", hasDescriptionAgentBlock: false },
      state,
      cachedDiffIndex: index,
    });
    const valid = validPayload({
      findings: [
        finding({
          file: "src/x.ts",
          startLine: 1,
          endLine: 1,
          title: "Zero-file PR",
        }),
      ],
    });
    await executor(valid);
    expect(publishReview).toHaveBeenCalledTimes(1);
  });

  it("returns aggregated anchor repair message for multiple invalid findings", async () => {
    evlog.initEvlog("info", { silent: true, suppressDrainWarning: true });
    const index = createCachedPrDiffIndex();
    ingestListPullRequestFilesResult(index, {
      files: [
        { filename: "a.ts", patch: ["@@ -1,1 +1,2 @@", " x", "+y"].join("\n") },
        { filename: "b.ts", patch: ["@@ -2,1 +2,2 @@", " x", "+y"].join("\n") },
      ],
    });
    const payload = validPayload({
      findings: [
        finding({ title: "Bad a" }),
        finding({ file: "b.ts", startLine: 88, endLine: 88, title: "Bad b" }),
      ],
    });
    await evlog.runWithOperationLogger({ method: "JOB", path: "/test" }, async () => {
      initReviewRunMetrics({
        provider: "openai",
        model: "gpt-4o-mini",
        mode: "review",
      });
      const state = createSubmitReviewState();
      const { executor } = buildSubmitReviewTool({
        cfg,
        token: "tok",
        ctx: {
          owner: "o",
          repo: "r",
          prNumber: 1,
          headSha: "sha",
          hasDescriptionAgentBlock: false,
        },
        state,
        cachedDiffIndex: index,
      });
      await expect(executor(payload)).rejects.toThrow(/Inline anchor validation failed/);
      expect(state.lastValidationError).toContain("findings[0]");
      expect(state.lastValidationError).toContain("findings[1]");
      expect(snapshotReviewRunMetrics()?.anchorFailureCount).toBe(2);
      expect(publishReview).not.toHaveBeenCalled();
    });
  });
});
