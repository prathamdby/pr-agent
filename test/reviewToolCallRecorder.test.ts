import { afterEach, describe, expect, it } from "vitest";
import * as evlog from "../src/evlog.js";
import { safeEmitToolCallMetric } from "../src/agent/providers/sessionMetrics.js";
import {
  initReviewRunMetrics,
  snapshotReviewRunMetrics,
} from "../src/review/run/reviewRunMetrics.js";
import { createReviewToolCallRecorder } from "../src/review/run/reviewToolCallRecorder.js";

describe("injected review tool-call recorder", () => {
  afterEach(() => {
    evlog.initEvlog("error", { silent: true, suppressDrainWarning: true });
  });

  it("records tool_call events with session role when a Review run metrics bag exists", async () => {
    evlog.initEvlog("info", { silent: true, suppressDrainWarning: true });
    await evlog.runWithOperationLogger({ method: "JOB", path: "/review" }, async () => {
      initReviewRunMetrics({ provider: "pi", model: "test", mode: "review" });
      const recorder = createReviewToolCallRecorder("reviewer:security");
      recorder({
        kind: "tool_call",
        name: "submitReviewerReport",
        ok: true,
        resultBytes: 4,
        resultCharacters: 4,
      });
      expect(snapshotReviewRunMetrics()).toMatchObject({
        toolCallCount: 1,
        bySessionRole: {
          "reviewer:security": { toolCallCount: 1, toolCallErrors: 0 },
        },
      });
    });
  });

  it("is a no-op when no Review run metrics bag exists", () => {
    const recorder = createReviewToolCallRecorder("orchestrator");
    expect(() =>
      recorder({ kind: "tool_call", name: "submitReview", ok: true }),
    ).not.toThrow();
    expect(snapshotReviewRunMetrics()).toBeNull();
  });

  it("swallows recorder failures so non-review sessions stay healthy", () => {
    expect(() =>
      safeEmitToolCallMetric(() => {
        throw new Error("boom");
      }, { kind: "tool_call", name: "noop", ok: true }),
    ).not.toThrow();
    expect(() =>
      safeEmitToolCallMetric(undefined, { kind: "tool_call", name: "noop", ok: true }),
    ).not.toThrow();
  });
});
