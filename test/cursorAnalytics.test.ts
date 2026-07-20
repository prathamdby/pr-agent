import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("../src/posthog.js", () => ({
  getPostHog: () => ({
    capture: mocks.capture,
    captureException: mocks.captureException,
  }),
}));

import {
  captureCursorWorkerEvent,
  captureCursorWorkerFailure,
} from "../src/agent/providers/cursor/cursorAnalytics.js";

describe("cursorAnalytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("captures cursor worker events with worker distinct id", () => {
    captureCursorWorkerEvent("cursor ripgrep configured", { source: "platform_package" });

    expect(mocks.capture).toHaveBeenCalledWith({
      distinctId: "worker",
      event: "cursor ripgrep configured",
      properties: {
        provider: "cursor",
        source: "platform_package",
      },
    });
  });

  it("captures cursor worker failures and exceptions with step context", () => {
    captureCursorWorkerFailure("ripgrep_required", new Error("missing rg"), {
      platform: "linux-x64",
    });

    expect(mocks.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "cursor worker failed",
        properties: expect.objectContaining({
          step: "ripgrep_required",
          error_message: "missing rg",
          platform: "linux-x64",
        }),
      }),
    );
    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      "worker",
      expect.objectContaining({
        type: "cursor",
        step: "ripgrep_required",
      }),
    );
  });
});
