import { beforeEach, describe, expect, it, vi } from "vitest";
import { tryLightweightAutoReviewCompletion } from "../src/agentWork/reviewLightweightCompletion.js";
import type { AgentWorkItem } from "../src/agentWork/types.js";
import { REVIEW_SUMMARY_SENTINEL } from "../src/review/reviewSchema.js";
import { createFakePrSurface } from "../src/github/prSurface.js";
import * as repo from "../src/agentWork/repository.js";
import {
  getSummaryCommentGithubId,
  recordPublishStep,
  shouldSkipWork,
} from "../src/agentWork/repository.js";
import * as reviewRunMetrics from "../src/review/run/reviewRunMetrics.js";
import { snapshotReviewRunMetrics } from "../src/review/run/reviewRunMetrics.js";
import type { ReviewRunMetricsSnapshot } from "../src/review/run/reviewRunMetrics.js";
import { createUnusedPool } from "./helpers/fakePool.js";
import { makeReviewWorkItem } from "./helpers/agentWorkItems.js";

const pool = createUnusedPool();

function autoReviewItem(overrides: { headSha?: string } = {}): AgentWorkItem {
  return makeReviewWorkItem({
    id: "wi-1",
    webhookEventId: "ev-1",
    source: "auto",
    status: "running",
    headSha: overrides.headSha ?? "sha",
    attemptCount: 1,
    cancelRequestedAt: new Date(),
  });
}

function metricsSnapshot(startedAtMs: number): ReviewRunMetricsSnapshot {
  return {
    provider: "test",
    model: "test",
    mode: "review",
    startedAtMs,
    published: false,
    publishAttempts: 0,
    submitCallCount: 0,
    validationFailureCount: 0,
    validationFailureKinds: {},
    coercionsApplied: {},
    toolInputRepairs: {},
    anchorFailureCount: 0,
    anchorFailureFiles: [],
    proseOnlyCollapsesByPhase: {},
    phaseRoundCounts: {},
    phaseSpansMs: {},
    rateLimitCircuitOpened: false,
    tokenNearExpiryGuardHits: 0,
    diffCacheEmptyAtFirstSubmit: false,
    toolCallCount: 0,
    toolCallErrors: 0,
    lastFailure: null,
    recentToolErrors: [],
    toolResultBytes: 0,
    toolResultCharacters: 0,
    modelTurnCount: 0,
    promptBytes: 0,
    promptCharacters: 0,
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    providerInputTokens: 0,
    providerOutputTokens: 0,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    cacheWrite1hTokens: null,
    cacheHitRate: null,
    cacheWriteAmplification: null,
    estimatedTurnCount: 0,
    findingsCount: 0,
    severities: [],
    wallClockMs: 0,
    specialistOutcomes: {},
    threadBatches: 0,
    briefFallback: false,
    providerSendMs: 0,
    toolMs: 0,
    generationMs: 0,
    tokenCoverage: "full_run",
  };
}

function fakeSurface() {
  return createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
}

describe("tryLightweightAutoReviewCompletion", () => {
  beforeEach(() => {
    vi.spyOn(repo, "getSummaryCommentGithubId").mockResolvedValue(null);
    vi.spyOn(repo, "shouldSkipWork");
    vi.spyOn(repo, "recordPublishStep").mockResolvedValue(undefined);
    vi.spyOn(reviewRunMetrics, "snapshotReviewRunMetrics");
    vi.clearAllMocks();
    vi.mocked(shouldSkipWork).mockResolvedValue(false);
    vi.mocked(snapshotReviewRunMetrics).mockReturnValue(null);
  });

  it("does not publish summary when shouldSkipWork is true", async () => {
    vi.mocked(shouldSkipWork).mockResolvedValue(true);
    const { surface, controls } = fakeSurface();

    const result = await tryLightweightAutoReviewCompletion(pool, {
      item: autoReviewItem(),
      reviewLens: "review",
      prSurface: surface,
      model: "grok-4.5",
      executionEpoch: 1,
      preflight: {
        files: [{ filename: "README.md" }],
        truncated: false,
        fileCount: 1,
        totalChanges: 1,
      },
    });

    expect(result).toEqual({
      handled: true,
      published: false,
      reason: "skipped",
    });
    expect(controls.events.filter((event) => event.kind === "upsertProgressComment")).toHaveLength(
      0,
    );
    expect(recordPublishStep).not.toHaveBeenCalled();
  });

  it("publishes summary when trivial and work is not skipped", async () => {
    const { surface, controls } = fakeSurface();
    const result = await tryLightweightAutoReviewCompletion(pool, {
      item: autoReviewItem(),
      reviewLens: "review",
      prSurface: surface,
      model: "grok-4.5",
      executionEpoch: 1,
      preflight: {
        files: [{ filename: "README.md" }],
        truncated: false,
        fileCount: 1,
        totalChanges: 1,
      },
    });

    expect(result).toMatchObject({ handled: true, published: true });
    expect(controls.events.some((event) => event.kind === "upsertProgressComment")).toBe(true);
    expect(recordPublishStep).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ step: "summary_comment" }),
    );
  });

  it("publishes a 0s footer when metrics snapshot is null", async () => {
    const { surface, controls } = fakeSurface();
    const result = await tryLightweightAutoReviewCompletion(pool, {
      item: autoReviewItem({ headSha: "abc123def456" }),
      reviewLens: "review",
      prSurface: surface,
      model: "grok-4.5",
      executionEpoch: 1,
      preflight: {
        files: [{ filename: "README.md" }],
        truncated: false,
        fileCount: 1,
        totalChanges: 1,
      },
    });

    expect(result).toMatchObject({ handled: true, published: true });
    expect(snapshotReviewRunMetrics).toHaveBeenCalled();
    const upsert = controls.events.find((event) => event.kind === "upsertProgressComment");
    expect(upsert?.kind === "upsertProgressComment" && upsert.body).toContain(
      "<sub>abc123d ⋅ general ⋅ 0s ⋅ grok-4.5</sub>",
    );
  });

  it("uses worker-start metrics for the footer duration and ignores stub post time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T12:10:00.000Z"));
    vi.mocked(snapshotReviewRunMetrics).mockReturnValue(
      metricsSnapshot(Date.parse("2026-07-22T12:08:00.000Z")),
    );
    const { surface, controls } = fakeSurface();

    await tryLightweightAutoReviewCompletion(pool, {
      item: autoReviewItem({ headSha: "abc123def456" }),
      reviewLens: "review",
      prSurface: surface,
      model: "grok-4.5",
      executionEpoch: 1,
      preflight: {
        files: [{ filename: "README.md" }],
        truncated: false,
        fileCount: 1,
        totalChanges: 1,
      },
    });

    const upsert = controls.events.find((event) => event.kind === "upsertProgressComment");
    expect(upsert?.kind === "upsertProgressComment" && upsert.body).toContain(
      "<sub>abc123d ⋅ general ⋅ 2m ⋅ grok-4.5</sub>",
    );
    vi.useRealTimers();
  });

  it("uses stored summary id when resolving the progress comment", async () => {
    vi.mocked(getSummaryCommentGithubId).mockResolvedValue(55);
    const { surface, controls } = fakeSurface();
    controls.setProgressComment(REVIEW_SUMMARY_SENTINEL, "existing", 55);

    await tryLightweightAutoReviewCompletion(pool, {
      item: autoReviewItem(),
      reviewLens: "review",
      prSurface: surface,
      model: "grok-4.5",
      executionEpoch: 1,
      preflight: {
        files: [{ filename: "README.md" }],
        truncated: false,
        fileCount: 1,
        totalChanges: 1,
      },
    });

    expect(getSummaryCommentGithubId).toHaveBeenCalledWith(pool, "o/r#1", "review");
    const resolve = controls.events.find((event) => event.kind === "resolveProgressComment");
    expect(resolve).toMatchObject({
      kind: "resolveProgressComment",
      hintCommentId: 55,
    });
    const upsert = controls.events.find((event) => event.kind === "upsertProgressComment");
    expect(upsert?.kind === "upsertProgressComment" && upsert.knownExisting).toMatchObject({
      id: 55,
    });
  });
});
