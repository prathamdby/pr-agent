import { beforeEach, describe, expect, it, vi } from "vitest";
import * as evlog from "../src/evlog.js";
import { buildSubmitReviewTool, createSubmitReviewState } from "../src/agent/submitReviewTool.js";
import { SECURITY_REVIEW_SUMMARY_SENTINEL } from "../src/agent/reviewSchema.js";
import {
  createCachedPrDiffIndex,
  ingestListPullRequestFilesResult,
} from "../src/agent/reviewDiffIndex.js";
import { initReviewRunMetrics, snapshotReviewRunMetrics } from "../src/agent/reviewRunMetrics.js";
import { REVIEW_DIFF_CACHE_REQUIRED_MESSAGE } from "../src/settings/index.js";

vi.mock("../src/agent/publishReview.js", () => ({
  publishReview: vi.fn(async () => undefined),
}));

import { publishReview } from "../src/agent/publishReview.js";

const cfg = {
  port: 3000,
  githubAppId: "1",
  githubAppPrivateKey: "k",
  webhookSecret: "s",
  piProvider: "openai" as const,
  piModel: "gpt-4o-mini",
  maxToolRounds: 1,
  maxReviewPublishAttempts: 3,
  maxReviewPublishCalls: 2,
  reviewConcurrency: 1,
  askConcurrency: 3,
  maxAskToolRounds: 12,
  webhookTimeoutMs: 10000,
  context7ApiKey: "",
  enableReviewLabelsEffort: false,
  enableReviewLabelsSecurity: false,
  logLevel: "info" as const,
  reviewInjectAnchorMenu: true,
  reviewRequireDiffCacheBeforeSubmit: true,
  reviewAnchorMenuMaxFiles: 40,
  reviewAnchorMenuMaxRangesPerFile: 20,
};

describe("submitReview tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(publishReview).mockResolvedValue(undefined);
  });

  it("ignores duplicate submitReview after publish", async () => {
    const state = createSubmitReviewState();
    const { executor } = buildSubmitReviewTool({
      cfg,
      token: "tok",
      ctx: { owner: "o", repo: "r", prNumber: 1, headSha: "sha" },
      state,
    });

    const valid = {
      prCharacter: "Does things.",
      findings: [],
      estimatedEffort: 1,
      relevantTests: "no" as const,
      securityConcerns: null,
      followUps: [],
    };

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
      ctx: { owner: "o", repo: "r", prNumber: 1, headSha: "sha" },
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

  it("caps valid publish executions at maxReviewPublishCalls", async () => {
    vi.mocked(publishReview).mockRejectedValue(new Error("publish failed"));
    const state = createSubmitReviewState();
    const { executor } = buildSubmitReviewTool({
      cfg: { ...cfg, maxReviewPublishCalls: 1 },
      token: "tok",
      ctx: { owner: "o", repo: "r", prNumber: 1, headSha: "sha" },
      state,
    });
    const valid = {
      prCharacter: "Does things.",
      findings: [],
      estimatedEffort: 1,
      relevantTests: "no" as const,
      securityConcerns: null,
      followUps: [],
    };

    await expect(executor(valid)).rejects.toThrow(/publish budget exhausted/i);
    expect(publishReview).toHaveBeenCalledTimes(1);
    expect(state.publishCallsExhausted).toBe(true);
  });

  it("treats abort-check failures as superseded publish", async () => {
    const state = createSubmitReviewState();
    const { executor } = buildSubmitReviewTool({
      cfg,
      token: "tok",
      ctx: { owner: "o", repo: "r", prNumber: 1, headSha: "sha" },
      state,
      shouldAbortPublish: async () => {
        throw new Error("db unavailable");
      },
    });
    const valid = {
      prCharacter: "Does things.",
      findings: [],
      estimatedEffort: 1,
      relevantTests: "no" as const,
      securityConcerns: null,
      followUps: [],
    };

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
      ctx: { owner: "o", repo: "r", prNumber: 1, headSha: "sha" },
      state,
      canEnforceDiffCacheBeforeSubmit: () => false,
      shouldAbortPublish: async () => true,
    });
    const valid = {
      prCharacter: "Does things.",
      findings: [],
      estimatedEffort: 1,
      relevantTests: "no" as const,
      securityConcerns: null,
      followUps: [],
    };

    await expect(executor(valid)).rejects.toThrow(/superseded or cancelled/i);
    expect(state.publishSuperseded).toBe(true);
    expect(publishReview).not.toHaveBeenCalled();
  });

  it("mentions the security summary sentinel in the tool description", () => {
    const { piTool } = buildSubmitReviewTool({
      cfg,
      token: "tok",
      ctx: { owner: "o", repo: "r", prNumber: 1, headSha: "sha" },
      mode: "review-security",
      state: createSubmitReviewState(),
    });
    expect(piTool.description).toContain(SECURITY_REVIEW_SUMMARY_SENTINEL);
  });

  it("blocks submit when listPullRequestFiles was not ingested", async () => {
    evlog.initEvlog("info", { silent: true, suppressDrainWarning: true });
    const valid = {
      prCharacter: "Does things.",
      findings: [],
      estimatedEffort: 1,
      relevantTests: "no" as const,
      securityConcerns: null,
      followUps: [],
    };
    await evlog.runWithOperationLogger({ method: "JOB", path: "/test" }, async () => {
      initReviewRunMetrics({ provider: "openai", model: "gpt-4o-mini", mode: "review" });
      const state = createSubmitReviewState();
      const { executor } = buildSubmitReviewTool({
        cfg,
        token: "tok",
        ctx: { owner: "o", repo: "r", prNumber: 1, headSha: "sha" },
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
      ctx: { owner: "o", repo: "r", prNumber: 1, headSha: "sha" },
      state,
      cachedDiffIndex: index,
      canEnforceDiffCacheBeforeSubmit: () => false,
    });
    const valid = {
      prCharacter: "Does things.",
      findings: [],
      estimatedEffort: 1,
      relevantTests: "no" as const,
      securityConcerns: null,
      followUps: [],
    };
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
      ctx: { owner: "o", repo: "r", prNumber: 1, headSha: "sha" },
      state,
      cachedDiffIndex: index,
      canEnforceDiffCacheBeforeSubmit: () => false,
    });
    const payload = {
      prCharacter: "Does things.",
      findings: [
        {
          severity: "P1" as const,
          file: "a.ts",
          startLine: 99,
          endLine: 99,
          title: "Bad anchor",
          detail: "d",
          fixPrompt: "fix",
        },
      ],
      estimatedEffort: 1,
      relevantTests: "no" as const,
      securityConcerns: null,
      followUps: [],
    };
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
      ctx: { owner: "o", repo: "r", prNumber: 1, headSha: "sha" },
      state,
      cachedDiffIndex: index,
    });
    const valid = {
      prCharacter: "Does things.",
      findings: [
        {
          severity: "P1" as const,
          file: "src/x.ts",
          startLine: 1,
          endLine: 1,
          title: "Zero-file PR",
          detail: "d",
          fixPrompt: "fix",
        },
      ],
      estimatedEffort: 1,
      relevantTests: "no" as const,
      securityConcerns: null,
      followUps: [],
    };
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
    const payload = {
      prCharacter: "Does things.",
      findings: [
        {
          severity: "P1" as const,
          file: "a.ts",
          startLine: 99,
          endLine: 99,
          title: "Bad a",
          detail: "d",
          fixPrompt: "fix",
        },
        {
          severity: "P1" as const,
          file: "b.ts",
          startLine: 88,
          endLine: 88,
          title: "Bad b",
          detail: "d",
          fixPrompt: "fix",
        },
      ],
      estimatedEffort: 1,
      relevantTests: "no" as const,
      securityConcerns: null,
      followUps: [],
    };
    await evlog.runWithOperationLogger({ method: "JOB", path: "/test" }, async () => {
      initReviewRunMetrics({ provider: "openai", model: "gpt-4o-mini", mode: "review" });
      const state = createSubmitReviewState();
      const { executor } = buildSubmitReviewTool({
        cfg,
        token: "tok",
        ctx: { owner: "o", repo: "r", prNumber: 1, headSha: "sha" },
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
