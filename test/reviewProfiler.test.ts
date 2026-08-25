import { describe, expect, it } from "vitest";
import type { ReviewRunMetricsSnapshot } from "../src/review/run/reviewRunMetrics.js";
import {
  reviewProfilerFailureProperties,
  reviewProfilerOutcome,
  reviewProfilerProperties,
} from "../src/review/run/reviewProfiler.js";

const cfg = { piProvider: "openai", piModel: "test" };
const claim = {
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  startedAt: new Date("2026-01-01T00:00:10.000Z"),
  attemptCount: 2,
};
const nowMs = Date.parse("2026-01-01T00:01:10.000Z");

function snapshot(overrides: Partial<ReviewRunMetricsSnapshot> = {}): ReviewRunMetricsSnapshot {
  return {
    provider: "openai",
    model: "test",
    mode: "review",
    startedAtMs: nowMs - 60_000,
    published: true,
    publishAttempts: 1,
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
    specialistOutcomes: {},
    threadBatches: 0,
    briefFallback: false,
    providerSendMs: 0,
    toolMs: 0,
    generationMs: 0,
    tokenCoverage: "orchestrator_only",
    ...overrides,
  };
}

describe("reviewProfilerOutcome", () => {
  it("returns every supported outcome", () => {
    expect(reviewProfilerOutcome({ published: false, publishSuperseded: true })).toBe("superseded");
    expect(reviewProfilerOutcome({ published: false })).toBe("failed");
    expect(
      reviewProfilerOutcome({
        published: true,
        publishAttempts: 1,
        snapshot: snapshot({ toolCallErrors: 1 }),
      }),
    ).toBe("degraded");
    expect(
      reviewProfilerOutcome({ published: true, publishAttempts: 1, snapshot: snapshot() }),
    ).toBe("published");
  });
});

describe("reviewProfilerProperties", () => {
  it("calculates queue, review, and total time from the claim", () => {
    const properties = reviewProfilerProperties({
      snapshot: null,
      cfg,
      claim,
      nowMs,
    });
    expect(properties).toMatchObject({
      provider: "openai",
      model: "test",
      attempt_count: 2,
      queue_ms: 10_000,
      review_ms: 60_000,
      total_ms: 70_000,
    });
    expect(properties).not.toHaveProperty("provider_output_tokens");
    expect(properties).not.toHaveProperty("generation_ms");
  });

  it("omits usage and cache fields when the snapshot has no provider usage", () => {
    const properties = reviewProfilerProperties({
      snapshot: snapshot({
        providerOutputTokens: 0,
        generationMs: 0,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        cacheHitRate: null,
      }),
      cfg,
      claim,
      nowMs,
    });
    expect(properties.provider_output_tokens).toBe(0);
    expect(properties).not.toHaveProperty("generation_ms");
    expect(properties).not.toHaveProperty("provider_output_tps");
    expect(properties).not.toHaveProperty("cache_read_tokens");
    expect(properties).not.toHaveProperty("cache_hit_rate");
  });

  it("flattens only known phase and specialist names", () => {
    const properties = reviewProfilerProperties({
      snapshot: snapshot({
        phaseSpansMs: {
          preflight: 40,
          "db-read": 12,
          investigation: 80,
          "/tmp/secret.ts": 999,
        },
        phaseRoundCounts: { investigation: 2, leaked: 7 },
        specialistOutcomes: { report: 2, empty: 1, error: 1, leaked: 4 },
        validationFailureKinds: { missing_field: 2, leaked: 3 },
        severities: ["P1", "P1", "P0", "mystery"],
        generationMs: 1_500,
        providerOutputTokens: 75,
        cacheReadTokens: 30,
        cacheWriteTokens: 5,
        cacheHitRate: 0.5,
        cacheWriteAmplification: 0.16,
        findingsCount: 3,
        toolCallCount: 4,
        briefFallback: true,
        rateLimitCircuitOpened: true,
        validationFailureCount: 2,
        coercionsApplied: { finding_severity_alias: 1 },
        toolInputRepairs: { "submitReview:object_wrapped_as_array": 2 },
      }),
      cfg,
      claim,
      nowMs,
    });
    expect(properties).toMatchObject({
      phase_preflight_ms: 40,
      phase_db_read_ms: 12,
      phase_investigation_ms: 80,
      phase_investigation_rounds: 2,
      specialist_report: 2,
      specialist_empty: 1,
      specialist_error: 1,
      validation_missing_field: 2,
      findings_p0: 1,
      findings_p1: 2,
      findings_count: 3,
      generation_ms: 1_500,
      provider_output_tps: 50,
      cache_read_tokens: 30,
      cache_write_tokens: 5,
      cache_hit_rate: 0.5,
      brief_fallback: true,
      rate_limit_circuit_opened: true,
      validation_failure_count: 2,
      coercion_count: 1,
      tool_input_repair_count: 2,
    });
    expect(properties).not.toHaveProperty("phase_/tmp/secret.ts_ms");
    expect(properties).not.toHaveProperty("phase_leaked_rounds");
    expect(properties).not.toHaveProperty("specialist_leaked");
    expect(properties).not.toHaveProperty("validation_leaked");
    expect(properties).not.toHaveProperty("findings_mystery");
  });

  it("removes forbidden snapshot fields from the property bag", () => {
    const properties = reviewProfilerProperties({
      snapshot: snapshot({
        lastFailure: {
          failureDomain: "provider",
          errorKind: "quota",
          errorMessage: "raw stack at /src/secret.ts https://example.com/err#deadbeef",
        },
        recentToolErrors: [
          {
            failureDomain: "github",
            errorKind: "not_found",
            errorMessage: "read /etc/passwd",
          },
        ],
        anchorFailureFiles: ["src/auth.ts", "https://github.com/acme/app"],
        promptBytes: 4096,
        promptCharacters: 4000,
      }),
      cfg,
      nowMs,
    });
    const serialized = JSON.stringify(properties);
    expect(properties).not.toHaveProperty("lastFailure");
    expect(properties).not.toHaveProperty("last_failure");
    expect(properties).not.toHaveProperty("recentToolErrors");
    expect(properties).not.toHaveProperty("anchorFailureFiles");
    expect(properties).not.toHaveProperty("anchor_failure_files");
    expect(properties).not.toHaveProperty("promptBytes");
    expect(properties).not.toHaveProperty("prompt_bytes");
    expect(properties).not.toHaveProperty("error_message");
    expect(serialized).not.toMatch(/\/src\/secret\.ts|https:\/\/|deadbeef|\/etc\/passwd|passwd/);
    expect(serialized).not.toContain("raw stack");
  });
});

describe("reviewProfilerFailureProperties", () => {
  it("keeps only bounded classified failure fields", () => {
    const properties = reviewProfilerFailureProperties({
      failureDomain: "provider",
      errorKind: "quota",
      errorMessage: "Insufficient credits at /tmp/secret.ts https://example.com/err",
      phase: "synthesis",
    });
    expect(properties).toEqual({
      failure_domain: "provider",
      error_kind: "quota",
      provider_error_kind: "quota",
      phase: "synthesis",
    });
    expect(properties).not.toHaveProperty("error_message");
    expect(JSON.stringify(properties)).not.toMatch(/credit|secret\.ts|https:\/\//);
  });

  it("omits unsafe phase text and non-provider error kinds", () => {
    const properties = reviewProfilerFailureProperties({
      failureDomain: "github",
      errorKind: "rate_limit",
      errorMessage: "API rate limit exceeded",
      phase: "/tmp/secret.ts",
    });
    expect(properties).toEqual({
      failure_domain: "github",
      error_kind: "rate_limit",
    });
    expect(properties).not.toHaveProperty("phase");
    expect(properties).not.toHaveProperty("provider_error_kind");
    expect(properties).not.toHaveProperty("error_message");
  });
});
