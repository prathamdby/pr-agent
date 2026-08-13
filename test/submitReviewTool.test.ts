import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePrSurface } from "../src/github/prSurface.js";
import * as evlog from "../src/evlog.js";
import { AppError } from "../src/errors/appError.js";
import {
  buildSubmitReviewTool,
  createSubmitReviewState,
} from "../src/review/publish/submitReviewTool.js";
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
import { REVIEW_SUMMARY_SENTINEL, type ReviewFinding } from "../src/review/reviewSchema.js";
import type { AcceptedPlacement } from "../src/review/orchestrator/orchestratorTypes.js";
import * as publishReviewModule from "../src/review/publish/publishReview.js";
import { publishReview } from "../src/review/publish/publishReview.js";
import type { JsonObject } from "../src/util/jsonValue.js";

const cfg = makeTestConfig({
  port: 3000,
  reviewConcurrency: 1,
  askConcurrency: 3,
  logLevel: "info",
});

function validPayload(overrides: JsonObject = {}): JsonObject {
  return {
    prCharacter: "Does things.",
    findings: [],
    size: "XS",
    relevantTests: "no",
    securityConcerns: null,
    followUps: [],
    ...overrides,
  };
}

function reviewFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    severity: "P1",
    file: "a.ts",
    startLine: 99,
    endLine: 99,
    title: "Finding",
    detail: "d",
    fixPrompt: "fix",
    ...overrides,
  };
}

function finding(overrides: JsonObject = {}): JsonObject {
  return {
    ...reviewFinding(),
    ...overrides,
  };
}

describe("submitReview tool", () => {
  beforeEach(() => {
    vi.spyOn(publishReviewModule, "publishReview").mockResolvedValue(undefined);
    vi.clearAllMocks();
  });

  it("seeds every resumed inline review id", () => {
    expect(createSubmitReviewState({ inlineReviewIds: [41, 42] }).inlineReviewIds).toEqual([
      41, 42,
    ]);
  });

  it("seeds the resumed thread call count independently from review ids", () => {
    expect(
      createSubmitReviewState({ inlineReviewIds: [41], threadCallCount: 8 }).threadCallCount,
    ).toBe(8);
  });

  it("forwards the work item and resumed placements to the V1 publisher", async () => {
    const resumedPlacement: AcceptedPlacement = {
      kind: "resumed",
      source: "review",
      placement: {
        finding: reviewFinding({ startLine: 4, endLine: 4 }),
        inlineLine: 4,
        inlinePosted: true,
      },
      canonicalFingerprint: "fp-1",
      reviewId: 41,
    };
    const { executor } = buildSubmitReviewTool({
      cfg,
      prSurface: createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 }).surface,
      ctx: { owner: "o", repo: "r", prNumber: 1, headSha: "sha", hasDescriptionReviewMap: false },
      state: createSubmitReviewState({ inlineReviewIds: [41] }),
      workItemId: "wi-1",
      resumedPlacements: [resumedPlacement],
    });

    await executor(validPayload());

    expect(publishReview).toHaveBeenCalledWith(
      expect.objectContaining({
        workItemId: "wi-1",
        resumedPlacements: [resumedPlacement],
      }),
    );
  });

  it("ignores duplicate submitReview after publish", async () => {
    const state = createSubmitReviewState();
    const { executor } = buildSubmitReviewTool({
      cfg,
      prSurface: createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 }).surface,
      ctx: { owner: "o", repo: "r", prNumber: 1, headSha: "sha", hasDescriptionReviewMap: false },
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
      prSurface: createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 }).surface,
      ctx: { owner: "o", repo: "r", prNumber: 1, headSha: "sha", hasDescriptionReviewMap: false },
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
    vi.mocked(publishReview).mockRejectedValue(new Error("publish failed"));
    const state = createSubmitReviewState();
    const { executor } = buildSubmitReviewTool({
      cfg,
      prSurface: createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 }).surface,
      ctx: { owner: "o", repo: "r", prNumber: 1, headSha: "sha", hasDescriptionReviewMap: false },
      state,
      maxReviewPublishCalls: 1,
    });
    const valid = validPayload();

    await expect(executor(valid)).rejects.toSatisfy((cause) => {
      expect(cause).toBeInstanceOf(AppError);
      if (!(cause instanceof AppError)) return false;
      expect(cause.code).toBe("review.publish_exhausted");
      expect(cause.message).toMatch(/publish budget exhausted/i);
      return true;
    });
    expect(publishReview).toHaveBeenCalledTimes(1);
    expect(state.publishCallsExhausted).toBe(true);
  });

  it("uses review.publish_failed when publish budget remains", async () => {
    vi.mocked(publishReview).mockRejectedValue(new Error("publish failed"));
    const state = createSubmitReviewState();
    const { executor } = buildSubmitReviewTool({
      cfg,
      prSurface: createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 }).surface,
      ctx: { owner: "o", repo: "r", prNumber: 1, headSha: "sha", hasDescriptionReviewMap: false },
      state,
      maxReviewPublishCalls: 2,
    });
    const valid = validPayload();

    await expect(executor(valid)).rejects.toSatisfy((cause) => {
      expect(cause).toBeInstanceOf(AppError);
      if (!(cause instanceof AppError)) return false;
      expect(cause.code).toBe("review.publish_failed");
      expect(cause.cause).toBeInstanceOf(Error);
      return true;
    });
    expect(state.publishCallsExhausted).toBe(false);
  });

  it("treats abort-check failures as superseded publish", async () => {
    const state = createSubmitReviewState();
    const { executor } = buildSubmitReviewTool({
      cfg,
      prSurface: createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 }).surface,
      ctx: { owner: "o", repo: "r", prNumber: 1, headSha: "sha", hasDescriptionReviewMap: false },
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
      prSurface: createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 }).surface,
      ctx: { owner: "o", repo: "r", prNumber: 1, headSha: "sha", hasDescriptionReviewMap: false },
      state,
      canEnforceDiffCacheBeforeSubmit: () => false,
      shouldAbortPublish: async () => true,
    });
    const valid = validPayload();

    await expect(executor(valid)).rejects.toThrow(/superseded or cancelled/i);
    expect(state.publishSuperseded).toBe(true);
    expect(publishReview).not.toHaveBeenCalled();
  });

  it("keeps the run unpublished when the final publish gate stops V1", async () => {
    const state = createSubmitReviewState();
    vi.mocked(publishReview).mockImplementationOnce(async ({ publishState }) => {
      publishState.publishSuperseded = true;
    });
    const { executor } = buildSubmitReviewTool({
      cfg,
      prSurface: createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 }).surface,
      ctx: { owner: "o", repo: "r", prNumber: 1, headSha: "sha", hasDescriptionReviewMap: false },
      state,
    });

    await expect(executor(validPayload())).resolves.toEqual({
      ok: false,
      publishSuperseded: true,
    });
    expect(state.published).toBe(false);
    expect(state.publishSuperseded).toBe(true);
  });

  it.each(["review-security", "review-quality", "review-tests"] as const)(
    "mentions the general summary sentinel for recognized %s mode",
    (mode) => {
      const { piTool } = buildSubmitReviewTool({
        cfg,
        prSurface: createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 }).surface,
        ctx: {
          owner: "o",
          repo: "r",
          prNumber: 1,
          headSha: "sha",
          hasDescriptionReviewMap: false,
        },
        mode,
        state: createSubmitReviewState(),
      });
      expect(piTool.description).toContain(REVIEW_SUMMARY_SENTINEL);
    },
  );

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
        prSurface: createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 }).surface,
        ctx: {
          owner: "o",
          repo: "r",
          prNumber: 1,
          headSha: "sha",
          hasDescriptionReviewMap: false,
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
      prSurface: createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 }).surface,
      ctx: { owner: "o", repo: "r", prNumber: 1, headSha: "sha", hasDescriptionReviewMap: false },
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
      prSurface: createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 }).surface,
      ctx: { owner: "o", repo: "r", prNumber: 1, headSha: "sha", hasDescriptionReviewMap: false },
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
      prSurface: createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 }).surface,
      ctx: { owner: "o", repo: "r", prNumber: 1, headSha: "sha", hasDescriptionReviewMap: false },
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
        prSurface: createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 }).surface,
        ctx: {
          owner: "o",
          repo: "r",
          prNumber: 1,
          headSha: "sha",
          hasDescriptionReviewMap: false,
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

  it("passes an already-valid payload through without touching it", async () => {
    evlog.initEvlog("info", { silent: true, suppressDrainWarning: true });
    const logDebug = vi.spyOn(evlog, "logDebug");
    const state = createSubmitReviewState();
    const { executor } = buildSubmitReviewTool({
      cfg,
      prSurface: createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 }).surface,
      ctx: { owner: "o", repo: "r", prNumber: 1, headSha: "sha", hasDescriptionReviewMap: false },
      state,
    });
    // Schema-valid, but the domain coercion would trim the padding if it ran.
    const payload = validPayload({ prCharacter: "  padded but valid  " });
    await executor(payload);
    expect(publishReview).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ prCharacter: "  padded but valid  " }),
      }),
    );
    expect(logDebug).not.toHaveBeenCalledWith("review_payload_coerced", expect.anything());
    logDebug.mockRestore();
  });

  it("runs domain coercions only after a validation failure", async () => {
    evlog.initEvlog("info", { silent: true, suppressDrainWarning: true });
    const logDebug = vi.spyOn(evlog, "logDebug");
    const state = createSubmitReviewState();
    const { executor } = buildSubmitReviewTool({
      cfg,
      prSurface: createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 }).surface,
      ctx: { owner: "o", repo: "r", prNumber: 1, headSha: "sha", hasDescriptionReviewMap: false },
      state,
    });
    // "high" is not a schema severity, so the first parse fails and the
    // domain severity-alias coercion repairs it.
    const payload = validPayload({ findings: [finding({ severity: "high" })] });
    await executor(payload);
    expect(logDebug).toHaveBeenCalledWith(
      "review_payload_coerced",
      expect.objectContaining({ coercions: expect.arrayContaining(["finding_severity_alias"]) }),
    );
    expect(publishReview).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          findings: expect.arrayContaining([expect.objectContaining({ severity: "P1" })]),
        }),
      }),
    );
    logDebug.mockRestore();
  });

  it("wraps a single-object findings payload via the generic repair, not a domain rule", async () => {
    evlog.initEvlog("info", { silent: true, suppressDrainWarning: true });
    const logDebug = vi.spyOn(evlog, "logDebug");
    await evlog.runWithOperationLogger({ method: "JOB", path: "/test" }, async () => {
      initReviewRunMetrics({ provider: "openai", model: "gpt-4o-mini", mode: "review" });
      const state = createSubmitReviewState();
      const { executor } = buildSubmitReviewTool({
        cfg,
        prSurface: createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 }).surface,
        ctx: {
          owner: "o",
          repo: "r",
          prNumber: 1,
          headSha: "sha",
          hasDescriptionReviewMap: false,
        },
        state,
      });
      await executor(validPayload({ findings: finding() }));
      expect(publishReview).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            findings: expect.arrayContaining([expect.objectContaining({ file: "a.ts" })]),
          }),
        }),
      );
      expect(logDebug).toHaveBeenCalledWith("tool_input_repaired", {
        tool: "submitReview",
        repairs: ["object_wrapped_as_array"],
      });
      expect(snapshotReviewRunMetrics()?.toolInputRepairs).toEqual({
        "submitReview:object_wrapped_as_array": 1,
      });
    });
    logDebug.mockRestore();
  });

  it("rescues a single-object finding that also needs a severity alias", async () => {
    // Shape error plus domain error in one payload: the generic repair wraps
    // it, the domain coercion maps "high", and neither alone is enough.
    const state = createSubmitReviewState();
    const { executor } = buildSubmitReviewTool({
      cfg,
      prSurface: createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 }).surface,
      ctx: { owner: "o", repo: "r", prNumber: 1, headSha: "sha", hasDescriptionReviewMap: false },
      state,
    });
    await executor(validPayload({ findings: finding({ severity: "high" }) }));
    expect(publishReview).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          findings: expect.arrayContaining([
            expect.objectContaining({ severity: "P1", file: "a.ts" }),
          ]),
        }),
      }),
    );
  });
});
