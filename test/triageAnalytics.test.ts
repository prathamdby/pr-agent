import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("../src/analytics/index.js", () => ({
  captureEvent: mocks.capture,
  captureException: mocks.captureException,
}));

import { captureCiStateChanged } from "../src/analytics/workCompleted.js";
import { ciWorkTelemetryFromRow } from "../src/agentWork/ciWorkTelemetry.js";

describe("CI state telemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
        projectionRepairPending: false,
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
});
