import { describe, expect, it } from "vitest";
import {
  degradedReasonFromReviewFlags,
  reviewWorkOutcome,
  workFailureReasonFromClassified,
} from "../src/analytics/workCompleted.js";
import { classifiedFailurePostHogProperties } from "../src/errors/classifiedFailure.js";
import type { ReviewRunMetricsSnapshot } from "../src/review/run/reviewRunMetrics.js";
import { reviewWorkExtras } from "../src/review/run/reviewProfiler.js";

function snapshot(overrides: Partial<ReviewRunMetricsSnapshot> = {}): ReviewRunMetricsSnapshot {
  return {
    provider: "openai",
    model: "test",
    mode: "review",
    startedAtMs: Date.parse("2026-01-01T00:00:10.000Z"),
    published: true,
    publishAttempts: 0,
    publishStepCount: 5,
    submitCallCount: 1,
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
    wallClockMs: 60_000,
    specialistOutcomes: { report: 4 },
    threadBatches: 0,
    briefFallback: false,
    providerSendMs: 0,
    toolMs: 0,
    generationMs: 0,
    tokenCoverage: "orchestrator_only",
    ...overrides,
  };
}

describe("reviewWorkOutcome", () => {
  it("returns every supported outcome", () => {
    expect(reviewWorkOutcome({ published: false, publishSuperseded: true })).toBe("superseded");
    expect(reviewWorkOutcome({ published: true, lightweight: true })).toBe("lightweight");
    expect(reviewWorkOutcome({ published: false, lightweight: true })).toBe("lightweight");
    expect(reviewWorkOutcome({ published: false })).toBe("failed");
    expect(
      reviewWorkOutcome({
        published: true,
        publishAttempts: 0,
        snapshot: snapshot({ toolCallErrors: 1 }),
      }),
    ).toBe("degraded");
    expect(reviewWorkOutcome({ published: true, publishAttempts: 0, snapshot: snapshot() })).toBe(
      "published",
    );
  });

  it("does not treat a clean four-report publish as degraded", () => {
    expect(
      reviewWorkOutcome({
        published: true,
        publishAttempts: 0,
        snapshot: snapshot({ publishStepCount: 5, specialistOutcomes: { report: 4 } }),
      }),
    ).toBe("published");
    expect(
      degradedReasonFromReviewFlags({
        publishAttempts: 0,
        snapshot: snapshot({ publishStepCount: 5 }),
      }),
    ).toBeNull();
  });

  it("treats recovery publishes as publish_retry", () => {
    expect(
      reviewWorkOutcome({
        published: true,
        publishAttempts: 1,
        snapshot: snapshot({ publishStepCount: 5 }),
      }),
    ).toBe("degraded");
    expect(degradedReasonFromReviewFlags({ publishAttempts: 1, snapshot: snapshot() })).toBe(
      "publish_retry",
    );
  });
});

describe("reviewWorkExtras", () => {
  it("keeps specialist counts and findings without token dumps", () => {
    const extras = reviewWorkExtras({
      snapshot: snapshot({
        findingsCount: 3,
        specialistOutcomes: { report: 2, empty: 1, error: 1 },
      }),
      provider: "openai",
      model: "test",
      reviewLens: "review",
      source: "slash",
    });
    expect(extras).toEqual({
      model: "test",
      provider: "openai",
      reviewLens: "review",
      source: "slash",
      findingsCount: 3,
      specialistReport: 2,
      specialistEmpty: 1,
      specialistError: 1,
    });
  });
});

describe("workFailureReasonFromClassified", () => {
  it("keeps only bounded classified failure fields", () => {
    const failure = workFailureReasonFromClassified({
      failureDomain: "provider",
      errorKind: "quota",
      errorMessage: "Insufficient credits at /tmp/secret.ts https://example.com/err",
      phase: "synthesis",
    });
    expect(failure).toEqual({
      failureDomain: "provider",
      errorKind: "quota",
      providerErrorKind: "quota",
      phase: "synthesis",
    });
    expect(failure).not.toHaveProperty("errorMessage");
    expect(JSON.stringify(failure)).not.toMatch(/secret\.ts|https:\/\//);
  });

  it("omits unsafe phase text from PostHog projections", () => {
    const classified = {
      failureDomain: "github" as const,
      errorKind: "rate_limit" as const,
      errorMessage: "API rate limit exceeded",
      phase: "/tmp/secret.ts",
    };
    expect(workFailureReasonFromClassified(classified)).toEqual({
      failureDomain: "github",
      errorKind: "rate_limit",
    });
    expect(classifiedFailurePostHogProperties(classified)).toEqual({
      failure_domain: "github",
      error_kind: "rate_limit",
    });
  });
});
