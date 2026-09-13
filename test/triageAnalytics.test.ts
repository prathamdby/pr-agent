import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("../src/analytics/index.js", () => ({
  captureEvent: mocks.capture,
  captureException: mocks.captureException,
}));

import {
  captureCiStateChanged,
  captureDurableWorkCompleted,
} from "../src/analytics/workCompleted.js";
import {
  captureDurableWorkCompletedWithCi,
  ciWorkTelemetryFromRow,
} from "../src/agentWork/ciWorkTelemetry.js";

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

  it("attaches CI properties on work completed", () => {
    captureDurableWorkCompleted({
      item,
      workType: "review",
      outcome: "published",
      durationMs: 10,
      attemptCount: 1,
      ci: { rollup: "failing", failingCount: 2, authored: true },
    });
    expect(mocks.capture).toHaveBeenCalledWith({
      distinctId: "installation:42",
      event: "work completed",
      properties: expect.objectContaining({
        ci_rollup: "failing",
        ci_failing_count: 2,
        ci_authored: true,
      }),
    });
  });

  it("maps an unknown rollup to incomplete and emits ci state changed only on a move", () => {
    expect(
      ciWorkTelemetryFromRow({
        owner: "o",
        repo: "r",
        headSha: "abc123",
        checks: {},
        rollup: "unknown",
        version: 3,
        authored: null,
        prNumbers: [],
        truncated: false,
        seededAt: null,
        firstSeenAt: new Date(),
        updatedAt: new Date(),
      }),
    ).toEqual({
      rollup: "unknown",
      failingCount: 0,
      authored: false,
      unavailableReason: "incomplete",
    });
    captureCiStateChanged({
      installationId: 42,
      owner: "o",
      repo: "r",
      headSha: "abc123",
      fromRollup: "pending",
      toRollup: "failing",
      version: 2,
    });
    captureCiStateChanged({
      installationId: 42,
      owner: "o",
      repo: "r",
      headSha: "abc123",
      fromRollup: "failing",
      toRollup: "failing",
      version: 3,
    });
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(mocks.capture).toHaveBeenCalledWith({
      distinctId: "installation:42",
      event: "ci state changed",
      properties: {
        owner: "o",
        repo: "r",
        head_sha: "abc123",
        from_rollup: "pending",
        to_rollup: "failing",
        version: 2,
      },
    });
  });

  it("marks a published review degraded when the CI row is unknown", async () => {
    const pool = {
      query: vi.fn(async () => ({
        rows: [
          {
            owner: "o",
            repo: "r",
            head_sha: "abc123",
            checks: {},
            rollup: "unknown",
            version: 1,
            authored: null,
            pr_numbers: [],
            truncated: false,
            seeded_at: null,
            first_seen_at: new Date(),
            updated_at: new Date(),
          },
        ],
      })),
    } as unknown as Pool;
    await captureDurableWorkCompletedWithCi(pool, {
      item,
      workType: "review",
      outcome: "published",
      durationMs: 10,
      attemptCount: 1,
    });
    expect(mocks.capture).toHaveBeenCalledWith({
      distinctId: "installation:42",
      event: "work completed",
      properties: expect.objectContaining({
        outcome: "degraded",
        degraded_reason: "ci_unavailable",
        ci_rollup: "unknown",
        ci_unavailable_reason: "incomplete",
      }),
    });
  });
});
