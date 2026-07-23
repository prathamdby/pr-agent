import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("../src/analytics/index.js", () => ({
  captureEvent: mocks.capture,
  captureException: mocks.captureException,
}));

import { captureTriageEvent, captureTriageFailure } from "../src/agentWork/triageAnalytics.js";

describe("triageAnalytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const ref = {
    installationId: 42,
    owner: "o",
    repo: "r",
    prNumber: 7,
    workItemId: "wi-1",
    scope: "all" as const,
  };

  it("captures triage events with installation distinct id", () => {
    captureTriageEvent(ref, "triage started");

    expect(mocks.capture).toHaveBeenCalledWith({
      distinctId: "installation:42",
      event: "triage started",
      properties: expect.objectContaining({
        owner: "o",
        repo: "r",
        pr_number: 7,
        work_item_id: "wi-1",
        scope: "all",
      }),
    });
  });

  it("captures triage failures and exceptions with step context", () => {
    captureTriageFailure(ref, "publish_push", new Error("push failed"), {
      inventory_count: 2,
    });

    expect(mocks.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "triage failed",
        properties: expect.objectContaining({
          step: "publish_push",
          failure_domain: expect.any(String),
          error_kind: expect.any(String),
          error_message: "push failed",
          inventory_count: 2,
        }),
      }),
    );
    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      "installation:42",
      expect.objectContaining({
        type: "triage",
        step: "publish_push",
      }),
    );
  });

  it("wraps non-Error failures before captureException", () => {
    captureTriageFailure(ref, "inventory", "missing anchor");

    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "missing anchor" }),
      "installation:42",
      expect.objectContaining({ step: "inventory" }),
    );
  });

  it("classifies provider credit failures on triage failed", () => {
    captureTriageFailure(ref, "agent_run", new Error("Insufficient credits for model"));

    expect(mocks.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "triage failed",
        properties: expect.objectContaining({
          failure_domain: "provider",
          error_kind: "quota",
          error_message: expect.stringMatching(/credit/i),
        }),
      }),
    );
  });
});
