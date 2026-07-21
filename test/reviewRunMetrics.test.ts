import { afterEach, describe, expect, it, vi } from "vitest";
import * as evlog from "../src/evlog.js";
import {
  initReviewRunMetrics,
  logReviewRunCompleted,
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
      setReviewRunMetricFields({ published: true, publishAttempts: 1 });

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
      });
      expect(snapshot?.wallClockMs).toBeGreaterThanOrEqual(0);
    });
  });

  it("emits review_run_completed envelope from snapshot", async () => {
    evlog.initEvlog("info", { silent: true, suppressDrainWarning: true });
    const infoSpy = vi.spyOn(evlog, "logInfo");
    await evlog.runWithOperationLogger({ method: "JOB", path: "/review" }, async () => {
      initReviewRunMetrics({
        provider: "cursor",
        model: "composer-2.5",
        mode: "review",
      });
      setReviewRunMetricFields({ published: false, publishAttempts: 2 });
      logReviewRunCompleted({ extra: true });
    });
    const payload = infoSpy.mock.calls.find(([event]) => event === "review_run_completed")?.[1];
    expect(payload).toMatchObject({
      provider: "cursor",
      model: "composer-2.5",
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
});
