import { afterEach, describe, expect, it, vi } from "vitest";
import * as evlog from "../src/evlog.js";
import {
  initReviewRunMetrics,
  logReviewRunCompleted,
  recordAgentTurnMetrics,
  recordReviewMetric,
  setReviewRunMetricFields,
  snapshotReviewRunMetrics,
} from "../src/review/run/reviewRunMetrics.js";

describe("reviewRunMetrics", () => {
  afterEach(() => {
    evlog.initEvlog("error", { silent: true, suppressDrainWarning: true });
  });

  it("is a no-op without ambient operation logger", () => {
    expect(() =>
      recordReviewMetric({
        kind: "tool_call",
        name: "getPullRequest",
        ok: true,
      }),
    ).not.toThrow();
    expect(snapshotReviewRunMetrics()).toBeNull();
  });

  it("records discriminated union events on ambient context", async () => {
    evlog.initEvlog("info", { silent: true, suppressDrainWarning: true });
    await evlog.runWithOperationLogger({ method: "JOB", path: "/review" }, async () => {
      initReviewRunMetrics({
        provider: "openai",
        model: "gpt-4o-mini",
        mode: "review",
      });
      recordReviewMetric({ kind: "phase_enter", phase: "investigation" });
      recordReviewMetric({
        kind: "tool_call",
        name: "listPullRequestFiles",
        ok: true,
        resultBytes: 120,
        resultCharacters: 118,
      });
      recordReviewMetric({
        kind: "tool_call",
        name: "submitReview",
        ok: false,
      });
      recordReviewMetric({
        kind: "submit_validated",
        coercions: ["finding_severity_alias"],
      });
      recordReviewMetric({
        kind: "validation_failed",
        failureKind: "missing_field",
        paths: ["findings"],
      });
      recordReviewMetric({
        kind: "anchor_failure",
        count: 2,
        files: ["a.ts", "b.ts"],
      });
      recordReviewMetric({ kind: "prose_only", phase: "pre_submit" });
      recordReviewMetric({ kind: "rate_limit_circuit_opened" });
      recordReviewMetric({ kind: "token_near_expiry_guard" });
      recordReviewMetric({ kind: "diff_cache_empty_at_submit" });
      recordReviewMetric({ kind: "publish_attempted" });
      recordReviewMetric({
        kind: "published",
        findingsCount: 1,
        severities: ["P1"],
      });
      recordReviewMetric({
        kind: "model_turn",
        prompt: { inputCharacters: 100, inputBytes: 104 },
        usage: {
          estimated: true,
          inputTokens: 25,
          outputTokens: 10,
          totalTokens: 35,
        },
      });
      recordReviewMetric({
        kind: "model_turn",
        prompt: { inputCharacters: 40, inputBytes: 40 },
        usage: {
          estimated: false,
          inputTokens: 12,
          outputTokens: 6,
          cacheReadTokens: 0,
          cacheWriteTokens: 3,
          totalTokens: 18,
        },
      });
      setReviewRunMetricFields({
        published: true,
        publishAttempts: 1,
        specialistOutcomes: { report: 2, empty: 1, error: 1 },
        threadBatches: 2,
        briefFallback: true,
      });

      const snapshot = snapshotReviewRunMetrics();
      expect(snapshot).toMatchObject({
        provider: "openai",
        model: "gpt-4o-mini",
        mode: "review",
        published: true,
        publishAttempts: 1,
        submitCallCount: 1,
        validationFailureCount: 1,
        validationFailureKinds: { missing_field: 1 },
        coercionsApplied: { finding_severity_alias: 1 },
        anchorFailureCount: 2,
        anchorFailureFiles: ["a.ts", "b.ts"],
        proseOnlyCollapsesByPhase: { pre_submit: 1 },
        phaseRoundCounts: { investigation: 1 },
        rateLimitCircuitOpened: true,
        tokenNearExpiryGuardHits: 1,
        diffCacheEmptyAtFirstSubmit: true,
        toolCallCount: 2,
        toolCallErrors: 1,
        toolResultBytes: 120,
        toolResultCharacters: 118,
        modelTurnCount: 2,
        promptBytes: 144,
        promptCharacters: 140,
        estimatedInputTokens: 25,
        estimatedOutputTokens: 10,
        providerInputTokens: 12,
        providerOutputTokens: 6,
        cacheReadTokens: 0,
        cacheWriteTokens: 3,
        estimatedTurnCount: 1,
        findingsCount: 1,
        severities: ["P1"],
        specialistOutcomes: { report: 2, empty: 1, error: 1 },
        threadBatches: 2,
        briefFallback: true,
      });
      expect(snapshot?.wallClockMs).toBeGreaterThanOrEqual(0);
    });
  });

  it("emits review_run_completed envelope from snapshot", async () => {
    evlog.initEvlog("info", { silent: true, suppressDrainWarning: true });
    const infoSpy = vi.spyOn(evlog, "logInfo");
    await evlog.runWithOperationLogger({ method: "JOB", path: "/review" }, async () => {
      initReviewRunMetrics({
        provider: "openai",
        model: "gpt-4o-mini",
        mode: "review",
      });
      setReviewRunMetricFields({ published: false, publishAttempts: 2 });
      logReviewRunCompleted({ extra: true });
    });
    const payload = infoSpy.mock.calls.find(([event]) => event === "review_run_completed")?.[1];
    expect(payload).toMatchObject({
      provider: "openai",
      model: "gpt-4o-mini",
      mode: "review",
      published: false,
      publishAttempts: 2,
      extra: true,
      modelTurnCount: 0,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    });
    expect(JSON.stringify(payload)).not.toMatch(/submitReview|password|BEGIN RSA/i);
    infoSpy.mockRestore();
  });

  it("seeds startedAtMs when provided at init", async () => {
    evlog.initEvlog("info", { silent: true, suppressDrainWarning: true });
    await evlog.runWithOperationLogger({ method: "JOB", path: "/review" }, async () => {
      initReviewRunMetrics({
        provider: "openai",
        model: "gpt-4o-mini",
        mode: "review",
        startedAtMs: 1_000,
      });
      const snapshot = snapshotReviewRunMetrics();
      expect(snapshot?.startedAtMs).toBe(1_000);
      expect(snapshot?.wallClockMs).toBeGreaterThanOrEqual(0);
    });
  });

  it("snapshots orchestrated phase receipt fields including all-empty runs", async () => {
    evlog.initEvlog("info", { silent: true, suppressDrainWarning: true });
    await evlog.runWithOperationLogger({ method: "JOB", path: "/review" }, async () => {
      initReviewRunMetrics({
        provider: "opencode-go",
        model: "hy3",
        mode: "review",
        startedAtMs: Date.now() - 60_000,
      });
      setReviewRunMetricFields({
        reconMs: 13_000,
        specialistCorrectnessMs: 8_000,
        specialistSecurityMs: 7_000,
        specialistQualityMs: 18_000,
        specialistTestsMs: 29_000,
        specialistsParallelMs: 29_000,
        synthesisMs: 6_000,
        published: true,
      });
      recordReviewMetric({
        kind: "published",
        findingsCount: 0,
        severities: [],
      });
      const snapshot = snapshotReviewRunMetrics();
      expect(snapshot).toMatchObject({
        reconMs: 13_000,
        specialistCorrectnessMs: 8_000,
        specialistSecurityMs: 7_000,
        specialistQualityMs: 18_000,
        specialistTestsMs: 29_000,
        specialistsParallelMs: 29_000,
        synthesisMs: 6_000,
        findingsCount: 0,
        wallClockMs: expect.any(Number),
      });
      expect(snapshot!.wallClockMs).toBeGreaterThanOrEqual(0);
      const sequential =
        (snapshot!.reconMs ?? 0) +
        (snapshot!.specialistsParallelMs ?? 0) +
        (snapshot!.synthesisMs ?? 0);
      expect(sequential).toBeLessThanOrEqual(snapshot!.wallClockMs + 1_000);
      const specialistSum =
        (snapshot!.specialistCorrectnessMs ?? 0) +
        (snapshot!.specialistSecurityMs ?? 0) +
        (snapshot!.specialistQualityMs ?? 0) +
        (snapshot!.specialistTestsMs ?? 0);
      expect(specialistSum).toBeGreaterThan(snapshot!.specialistsParallelMs ?? 0);
    });
  });

  it("retains lastFailure and recent tool errors when tool_call fails with error text", async () => {
    evlog.initEvlog("info", { silent: true, suppressDrainWarning: true });
    await evlog.runWithOperationLogger({ method: "JOB", path: "/review" }, async () => {
      initReviewRunMetrics({
        provider: "pi",
        model: "m",
        mode: "review",
      });
      recordReviewMetric({
        kind: "tool_call",
        name: "publish_summary",
        ok: false,
        errorMessage: "Insufficient credits",
      });
      const snap = snapshotReviewRunMetrics();
      expect(snap?.toolCallErrors).toBe(1);
      expect(snap?.lastFailure?.errorKind).toBe("quota");
      expect(snap?.lastFailure?.toolName).toBe("publish_summary");
      expect(snap?.lastFailure?.errorMessage.toLowerCase()).toContain("credit");
      expect(snap?.recentToolErrors).toHaveLength(1);
    });
  });

  it("accumulates toolMs and providerSendMs into formula-B snapshot fields", async () => {
    evlog.initEvlog("info", { silent: true, suppressDrainWarning: true });
    await evlog.runWithOperationLogger({ method: "JOB", path: "/review" }, async () => {
      initReviewRunMetrics({
        provider: "openai",
        model: "gpt-4o-mini",
        mode: "review",
      });
      recordReviewMetric({
        kind: "tool_call",
        name: "listPullRequestFiles",
        ok: true,
        durationMs: 400,
      });
      recordReviewMetric({
        kind: "tool_call",
        name: "getFile",
        ok: true,
        durationMs: 100,
      });
      recordReviewMetric({ kind: "session_send_span", sendMs: 2_000 });
      recordReviewMetric({
        kind: "model_turn",
        usage: {
          estimated: false,
          inputTokens: 10,
          outputTokens: 50,
          totalTokens: 60,
        },
      });

      const snapshot = snapshotReviewRunMetrics();
      expect(snapshot).toMatchObject({
        toolMs: 500,
        providerSendMs: 2_000,
        generationMs: 1_500,
        providerOutputTokens: 50,
        providerOutputTps: 50 / 1.5,
        tokenCoverage: "orchestrator_only",
      });
    });
  });

  it("clamps generationMs to 0 and omits providerOutputTps", async () => {
    evlog.initEvlog("info", { silent: true, suppressDrainWarning: true });
    await evlog.runWithOperationLogger({ method: "JOB", path: "/review" }, async () => {
      initReviewRunMetrics({
        provider: "openai",
        model: "gpt-4o-mini",
        mode: "review",
      });
      recordReviewMetric({
        kind: "tool_call",
        name: "listPullRequestFiles",
        ok: true,
        durationMs: 800,
      });
      recordReviewMetric({ kind: "session_send_span", sendMs: 500 });
      recordReviewMetric({
        kind: "model_turn",
        usage: {
          estimated: false,
          outputTokens: 20,
          totalTokens: 20,
        },
      });

      const snapshot = snapshotReviewRunMetrics();
      expect(snapshot?.providerSendMs).toBe(500);
      expect(snapshot?.toolMs).toBe(800);
      expect(snapshot?.generationMs).toBe(0);
      expect(snapshot?.providerOutputTokens).toBe(20);
      expect(snapshot).not.toHaveProperty("providerOutputTps");
      expect(snapshot?.tokenCoverage).toBe("orchestrator_only");
    });
  });

  it("marks tokenCoverage full_run after specialist recordAgentTurnMetrics", async () => {
    evlog.initEvlog("info", { silent: true, suppressDrainWarning: true });
    await evlog.runWithOperationLogger({ method: "JOB", path: "/review" }, async () => {
      initReviewRunMetrics({
        provider: "openai",
        model: "gpt-4o-mini",
        mode: "review",
      });
      expect(snapshotReviewRunMetrics()?.tokenCoverage).toBe("orchestrator_only");

      recordAgentTurnMetrics(
        {
          text: "specialist report",
          usage: {
            estimated: false,
            inputTokens: 8,
            outputTokens: 12,
            totalTokens: 20,
          },
        },
        { specialist: true },
      );

      const snapshot = snapshotReviewRunMetrics();
      expect(snapshot?.tokenCoverage).toBe("full_run");
      expect(snapshot?.providerOutputTokens).toBe(12);
      expect(snapshot?.modelTurnCount).toBe(1);
    });
  });
});
