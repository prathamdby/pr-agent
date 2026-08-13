import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  captureEvent,
  captureException,
  initAnalytics,
  initNoOpAnalytics,
  isAnalyticsEnabled,
  resetPostHogClientFactory,
  setPostHogClientFactory,
  shutdownAnalytics,
} from "../src/analytics/index.js";
import type { PostHogClientOptions } from "../src/analytics/posthogSink.js";

type CapturedPostHogEvent = {
  readonly distinctId: string;
  readonly event: string;
  readonly properties?: { readonly error_message?: string };
};

function applyBeforeSend(
  beforeSend: PostHogClientOptions["before_send"],
  event: CapturedPostHogEvent,
) {
  if (beforeSend === undefined) return event;
  const hooks = Array.isArray(beforeSend) ? beforeSend : [beforeSend];
  let current: Parameters<(typeof hooks)[number]>[0] = event;
  for (const hook of hooks) {
    current = hook(current);
    if (current == null) return null;
  }
  return current;
}

function errorMessageFromEvent(event: { properties?: { error_message?: string } } | null): string {
  return event?.properties?.error_message ?? "";
}

type FakePostHogClient = {
  readonly apiKey: string;
  readonly options: PostHogClientOptions;
  readonly shutdown: Mock;
  readonly capture: Mock;
  readonly captureException: Mock;
};

const instances: FakePostHogClient[] = [];
const postHogFactory = vi.fn((apiKey: string, options: PostHogClientOptions) => {
  const shutdown = vi.fn(async () => undefined);
  const capture = vi.fn();
  const captureExceptionFn = vi.fn();
  const client = {
    apiKey,
    options,
    shutdown,
    capture,
    captureException: captureExceptionFn,
  };
  instances.push(client);
  return client;
});

describe("analytics facade", () => {
  beforeEach(() => {
    instances.length = 0;
    postHogFactory.mockClear();
    setPostHogClientFactory(postHogFactory);
  });

  afterEach(async () => {
    await shutdownAnalytics();
    resetPostHogClientFactory();
    initNoOpAnalytics();
    vi.restoreAllMocks();
    instances.length = 0;
  });

  it("does not load posthog-node when token is empty", async () => {
    await initAnalytics({ projectToken: "", host: "" });
    captureEvent({
      distinctId: "server",
      event: "webhook received",
      properties: { github_event: "ping" },
    });
    captureException(new Error("boom"), "server", { step: "test" });
    await shutdownAnalytics();

    expect(postHogFactory).not.toHaveBeenCalled();
    expect(instances).toHaveLength(0);
  });

  it("lazy-loads PostHog with autocapture and sanitizer when token is set", async () => {
    await initAnalytics({
      projectToken: "phc_test_token",
      host: "https://posthog.example",
    });

    expect(postHogFactory).toHaveBeenCalledWith("phc_test_token", {
      host: "https://posthog.example",
      enableExceptionAutocapture: true,
      before_send: expect.any(Function),
    });

    const beforeSend = instances[0]?.options?.before_send;
    const token = "ghp_1234567890123456789012345678901234";
    const sanitized = applyBeforeSend(beforeSend, {
      distinctId: "installation:1",
      event: "triage failed",
      properties: { error_message: `push failed Bearer ${token}` },
    });
    expect(errorMessageFromEvent(sanitized)).toContain("[redacted]");
  });

  it("forwards captureEvent and captureException to the PostHog client", async () => {
    await initAnalytics({ projectToken: "token", host: "" });
    const err = new Error("fail");
    captureEvent({
      distinctId: "installation:1",
      event: "work item failed",
      properties: { type: "review" },
    });
    captureException(err, "installation:1", { type: "review" });

    const client = instances[0];
    expect(client?.capture).toHaveBeenCalledWith({
      distinctId: "installation:1",
      event: "work item failed",
      properties: { type: "review" },
    });
    expect(client?.captureException).toHaveBeenCalledWith(err, "installation:1", {
      type: "review",
    });
  });

  it("shuts down the client and no-ops shutdown when disabled", async () => {
    await initAnalytics({ projectToken: "token", host: "" });
    await shutdownAnalytics();
    expect(instances[0]?.shutdown).toHaveBeenCalledTimes(1);

    instances.length = 0;
    postHogFactory.mockClear();
    await initAnalytics({ projectToken: "  ", host: "" });
    await expect(shutdownAnalytics()).resolves.toBeUndefined();
    expect(postHogFactory).not.toHaveBeenCalled();
  });

  it("forwards logError to captureException when analytics is enabled", async () => {
    await initAnalytics({ projectToken: "token", host: "" });

    const { AppError } = await import("../src/errors/appError.js");
    const { logError } = await import("../src/evlog.js");
    const err = new AppError({
      code: "agent_work.failed",
      message: "boom",
      context: { workItemId: "w1" },
    });

    logError(
      "agent_work_failed",
      {
        message: err.message,
        installationId: 42,
        errorCode: err.code,
        errorContext: err.context,
      },
      err,
    );

    const client = instances[0];
    expect(client?.captureException).toHaveBeenCalledTimes(1);
    const call = client?.captureException.mock.calls[0];
    expect(call?.[0]).toBe(err);
    expect(call?.[1]).toBe("installation:42");
    expect(call?.[2]).toMatchObject({
      event: "agent_work_failed",
      errorCode: "agent_work.failed",
      errorContext: { workItemId: "w1" },
    });
  });

  it("does not forward logError when analytics is disabled", async () => {
    await initAnalytics({ projectToken: "", host: "" });

    const { logError } = await import("../src/evlog.js");
    logError("agent_work_failed", { message: "boom", installationId: 1 });

    expect(postHogFactory).not.toHaveBeenCalled();
  });

  it("resolves logError distinct ids from analyticsDistinctId and string installationId", async () => {
    await initAnalytics({ projectToken: "token", host: "" });
    const { logError } = await import("../src/evlog.js");

    logError("agent_work_failed", { analyticsDistinctId: "custom-id", message: "a" });
    logError("agent_work_failed", { installationId: "gh-123", message: "b" });
    logError("agent_work_failed", { message: "c" });

    const calls = instances[0]?.captureException.mock.calls ?? [];
    expect(calls[0]?.[1]).toBe("custom-id");
    expect(calls[1]?.[1]).toBe("installation:gh-123");
    expect(calls[2]?.[1]).toBe("server");
  });

  it("builds captureException errors from non-Error args and meta fallbacks", async () => {
    await initAnalytics({ projectToken: "token", host: "" });
    const { logError } = await import("../src/evlog.js");

    logError("agent_work_failed", { installationId: 1 }, "raw string");
    logError("agent_work_failed", { installationId: 1, message: "fallback" });
    logError("agent_work_failed", { installationId: 1 });

    const calls = instances[0]?.captureException.mock.calls ?? [];
    expect(calls[0]?.[0]).toEqual(expect.objectContaining({ message: "raw string" }));
    expect(calls[1]?.[0]).toEqual(expect.objectContaining({ message: "fallback" }));
    expect(calls[2]?.[0]).toEqual(expect.objectContaining({ message: "agent_work_failed" }));
  });

  it("strips analyticsDistinctId, error, and err from forwarded properties", async () => {
    await initAnalytics({ projectToken: "token", host: "" });
    const { logError } = await import("../src/evlog.js");

    logError(
      "ev",
      { analyticsDistinctId: "x", error: "skip", err: "skip", kept: 1 },
      new Error("boom"),
    );

    const props = instances[0]?.captureException.mock.calls[0]?.[2];
    expect(props).toMatchObject({ event: "ev", kept: 1 });
    expect(props).not.toHaveProperty("analyticsDistinctId");
    expect(props).not.toHaveProperty("error");
    expect(props).not.toHaveProperty("err");
  });

  it("keeps analytics disabled when PostHog sink construction fails", async () => {
    postHogFactory.mockImplementationOnce(() => {
      throw new Error("sdk missing");
    });

    await expect(initAnalytics({ projectToken: "token", host: "" })).rejects.toThrow(/sdk missing/);
    expect(isAnalyticsEnabled()).toBe(false);
  });

  it("does not register process signal listeners", async () => {
    const processOn = vi.spyOn(process, "on");
    await import("../src/analytics/index.js");
    expect(processOn).not.toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(processOn).not.toHaveBeenCalledWith("SIGTERM", expect.any(Function));
  });

  it("initNoOpAnalytics keeps capture paths no-op without constructing PostHog", () => {
    initNoOpAnalytics();
    captureEvent({ distinctId: "server", event: "webhook received" });
    expect(isAnalyticsEnabled()).toBe(false);
    expect(postHogFactory).not.toHaveBeenCalled();
  });

  it("shutdownAnalytics resolves when no client was initialised", async () => {
    await expect(shutdownAnalytics()).resolves.toBeUndefined();
  });

  it("before_send leaves events without error fields unchanged", async () => {
    await initAnalytics({ projectToken: "token", host: "" });

    const beforeSend = instances[0]?.options?.before_send;
    const event = { distinctId: "x", event: "y" };
    expect(applyBeforeSend(beforeSend, event)).toBe(event);
  });
});
