import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("../src/posthog.js", () => ({
  posthog: {
    capture: mocks.capture,
    captureException: mocks.captureException,
  },
}));

import { captureAgentProviderBootFailure } from "../src/agent/providers/bootAnalytics.js";

describe("provider boot analytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("captures provider-neutral boot failures", () => {
    const error = new Error("boot failed");

    captureAgentProviderBootFailure("pi", error);

    expect(mocks.capture).toHaveBeenCalledWith({
      distinctId: "worker",
      event: "agent provider boot failed",
      properties: {
        provider: "pi",
        error_message: "boot failed",
      },
    });
    expect(mocks.captureException).toHaveBeenCalledWith(error, "worker", {
      type: "agent_provider_boot",
      provider: "pi",
    });
  });
});
