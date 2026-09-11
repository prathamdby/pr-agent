import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("../src/analytics/index.js", () => ({
  captureEvent: mocks.capture,
  captureException: mocks.captureException,
}));

import { captureDurableWorkCompleted } from "../src/analytics/workCompleted.js";

describe("triage work completed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const item = {
    id: "wi-1",
    installationId: 42,
    owner: "o",
    repo: "r",
    prNumber: 7,
    headSha: "abc123",
    attemptCount: 1,
  };

  it("emits the shared envelope for a published triage run", () => {
    captureDurableWorkCompleted({
      item,
      workType: "triage",
      outcome: "published",
      durationMs: 1200,
      attemptCount: 1,
      extras: { scope: "all" },
    });

    expect(mocks.capture).toHaveBeenCalledWith({
      distinctId: "installation:42",
      event: "work completed",
      properties: expect.objectContaining({
        work_item_id: "wi-1",
        work_type: "triage",
        outcome: "published",
        reason: "published",
        owner: "o",
        repo: "r",
        pr_number: 7,
        head_sha: "abc123",
        duration_ms: 1200,
        attempt_count: 1,
        scope: "all",
        publish_attempts: 0,
        publish_step_count: 0,
      }),
    });
    expect(mocks.captureException).not.toHaveBeenCalled();
    const properties = mocks.capture.mock.calls[0]?.[0].properties as Record<string, unknown>;
    expect(properties).not.toHaveProperty("error_message");
    expect(properties).not.toHaveProperty("cause_chain");
  });

  it("emits degraded_reason without a failure exception", () => {
    captureDurableWorkCompleted({
      item,
      workType: "triage",
      outcome: "degraded",
      durationMs: 800,
      attemptCount: 1,
      degradedReason: "durable_degradation",
      extras: { scope: "thread", durableDegradation: "push_closed" },
    });

    expect(mocks.capture).toHaveBeenCalledWith({
      distinctId: "installation:42",
      event: "work completed",
      properties: expect.objectContaining({
        work_type: "triage",
        outcome: "degraded",
        reason: "durable_degradation",
        degraded_reason: "durable_degradation",
        durable_degradation: "push_closed",
        scope: "thread",
      }),
    });
    expect(mocks.captureException).not.toHaveBeenCalled();
  });
});
