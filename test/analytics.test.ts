import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

type PostHogOptions = {
  readonly host?: string;
  readonly enableExceptionAutocapture?: boolean;
  readonly before_send?: (event: unknown) => unknown;
};

const mockPostHog = vi.hoisted(() => {
  const instances: Array<{
    readonly apiKey: string;
    readonly options: PostHogOptions;
    readonly shutdown: Mock;
    readonly capture: Mock;
    readonly captureException: Mock;
  }> = [];

  return {
    instances,
    PostHog: vi.fn(function MockPostHog(apiKey: string, options: PostHogOptions) {
      const shutdown = vi.fn(async () => undefined);
      const capture = vi.fn();
      const captureException = vi.fn();
      instances.push({ apiKey, options, shutdown, capture, captureException });
      return { shutdown, capture, captureException };
    }),
  };
});

vi.mock("posthog-node", () => ({ PostHog: mockPostHog.PostHog }));

describe("analytics facade", () => {
  beforeEach(() => {
    vi.resetModules();
    mockPostHog.instances.length = 0;
    mockPostHog.PostHog.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    mockPostHog.instances.length = 0;
  });

  it("does not load posthog-node when token is empty", async () => {
    const analytics = await import("../src/analytics/index.js");

    await analytics.initAnalytics({ projectToken: "", host: "" });
    analytics.captureEvent({
      distinctId: "server",
      event: "webhook received",
      properties: { github_event: "ping" },
    });
    analytics.captureException(new Error("boom"), "server", { step: "test" });
    await analytics.shutdownAnalytics();

    expect(mockPostHog.PostHog).not.toHaveBeenCalled();
    expect(mockPostHog.instances).toHaveLength(0);
  });

  it("lazy-loads PostHog with autocapture and sanitizer when token is set", async () => {
    const analytics = await import("../src/analytics/index.js");

    await analytics.initAnalytics({
      projectToken: "phc_test_token",
      host: "https://posthog.example",
    });

    expect(mockPostHog.PostHog).toHaveBeenCalledWith("phc_test_token", {
      host: "https://posthog.example",
      enableExceptionAutocapture: true,
      before_send: expect.any(Function),
    });

    const beforeSend = mockPostHog.instances[0]?.options.before_send;
    const token = ["ghp", "1234567890123456789012345678901234"].join("_");
    const sanitized = beforeSend?.({
      distinctId: "installation:1",
      event: "triage failed",
      properties: { error_message: `push failed Bearer ${token}` },
    });
    expect(
      String((sanitized as { properties?: { error_message?: string } })?.properties?.error_message),
    ).toContain("[redacted]");
  });

  it("forwards captureEvent and captureException to the PostHog client", async () => {
    const analytics = await import("../src/analytics/index.js");

    await analytics.initAnalytics({ projectToken: "token", host: "" });
    const err = new Error("fail");
    analytics.captureEvent({
      distinctId: "installation:1",
      event: "work item failed",
      properties: { type: "review" },
    });
    analytics.captureException(err, "installation:1", { type: "review" });

    const client = mockPostHog.instances[0];
    expect(client?.capture).toHaveBeenCalledWith({
      distinctId: "installation:1",
      event: "work item failed",
      properties: { type: "review" },
    });
    expect(client?.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Error", message: "fail" }),
      "installation:1",
      {
        type: "review",
      },
    );
  });

  it("sanitizes distinct ids before forwarding events and exceptions", async () => {
    const analytics = await import("../src/analytics/index.js");

    await analytics.initAnalytics({ projectToken: "token", host: "" });
    const token = ["ghp", "1234567890123456789012345678901234"].join("_");
    const databaseUrl = ["postgres:", "//user:pass@db/app"].join("");
    const apiKey = ["sk", "-abcdefghijklmnopqrstuvwxyz"].join("");
    const distinctId = `Bearer ${token} ${databaseUrl} ${apiKey}`;

    analytics.captureEvent({ distinctId, event: "work item failed" });
    analytics.captureException(new Error("boom"), distinctId);

    const client = mockPostHog.instances[0];
    const eventDistinctId = client?.capture.mock.calls[0]?.[0]?.distinctId as string;
    const exceptionDistinctId = client?.captureException.mock.calls[0]?.[1] as string;
    expect(eventDistinctId).toContain("[redacted]");
    expect(exceptionDistinctId).toContain("[redacted]");
    expect(eventDistinctId).not.toContain(token);
    expect(exceptionDistinctId).not.toContain(token);
    expect(JSON.stringify(client?.capture.mock.calls[0])).not.toContain(databaseUrl);
    expect(JSON.stringify(client?.captureException.mock.calls[0])).not.toContain(apiKey);
  });

  it("shuts down the client and no-ops shutdown when disabled", async () => {
    const analytics = await import("../src/analytics/index.js");

    await analytics.initAnalytics({ projectToken: "token", host: "" });
    await analytics.shutdownAnalytics();
    expect(mockPostHog.instances[0]?.shutdown).toHaveBeenCalledTimes(1);

    vi.resetModules();
    mockPostHog.instances.length = 0;
    mockPostHog.PostHog.mockClear();
    const disabled = await import("../src/analytics/index.js");
    await disabled.initAnalytics({ projectToken: "  ", host: "" });
    await expect(disabled.shutdownAnalytics()).resolves.toBeUndefined();
    expect(mockPostHog.PostHog).not.toHaveBeenCalled();
  });

  it("forwards logError to captureException when analytics is enabled", async () => {
    const analytics = await import("../src/analytics/index.js");
    await analytics.initAnalytics({ projectToken: "token", host: "" });

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

    const client = mockPostHog.instances[0];
    expect(client?.captureException).toHaveBeenCalledTimes(1);
    const call = client?.captureException.mock.calls[0];
    expect(call?.[0]).not.toBe(err);
    expect(call?.[0]).toMatchObject({ name: "AppError", message: "boom" });
    expect(call?.[1]).toBe("installation:42");
    expect(call?.[2]).toMatchObject({
      event: "agent_work_failed",
      errorCode: "agent_work.failed",
      errorContext: { workItemId: "w1" },
    });
  });

  it("sanitizes AppError telemetry before both analytics forwarding paths", async () => {
    const analytics = await import("../src/analytics/index.js");
    await analytics.initAnalytics({ projectToken: "token", host: "" });

    const { AppError, errorLogFields } = await import("../src/errors/appError.js");
    const { logError } = await import("../src/evlog.js");
    const token = ["ghp", "1234567890123456789012345678901234"].join("_");
    const error = new AppError({
      code: "agent_work.failed",
      message: `failed Bearer ${token}`,
      context: {
        workItemId: "w1",
        rawValue: { database: "postgres://user:pass@db/app" },
      },
      cause: new Error("OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz"),
    });

    logError(
      "agent_work_failed",
      {
        installationId: 42,
        ...errorLogFields(error),
      },
      error,
    );

    const call = mockPostHog.instances[0]?.captureException.mock.calls[0];
    const forwardedError = call?.[0] as Error;
    const properties = call?.[2] as Record<string, unknown>;
    expect(forwardedError).not.toBe(error);
    expect(forwardedError.message).toContain("[redacted]");
    expect(properties.errorCode).toBe("agent_work.failed");
    expect(properties.errorContext).toMatchObject({ workItemId: "w1" });
    const json = JSON.stringify({ forwardedError, properties });
    expect(json).not.toContain(token);
    expect(json).not.toContain("postgres://");
    expect(json).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
  });

  it("does not forward logError when analytics is disabled", async () => {
    const analytics = await import("../src/analytics/index.js");
    await analytics.initAnalytics({ projectToken: "", host: "" });

    const { logError } = await import("../src/evlog.js");
    logError("agent_work_failed", { message: "boom", installationId: 1 });

    expect(mockPostHog.PostHog).not.toHaveBeenCalled();
  });

  it("resolves logError distinct ids from analyticsDistinctId and string installationId", async () => {
    const analytics = await import("../src/analytics/index.js");
    await analytics.initAnalytics({ projectToken: "token", host: "" });
    const { logError } = await import("../src/evlog.js");

    logError("agent_work_failed", { analyticsDistinctId: "custom-id", message: "a" });
    logError("agent_work_failed", { installationId: "gh-123", message: "b" });
    logError("agent_work_failed", { message: "c" });

    const calls = mockPostHog.instances[0]?.captureException.mock.calls ?? [];
    expect(calls[0]?.[1]).toBe("custom-id");
    expect(calls[1]?.[1]).toBe("installation:gh-123");
    expect(calls[2]?.[1]).toBe("server");
  });

  it("builds captureException errors from non-Error args and meta fallbacks", async () => {
    const analytics = await import("../src/analytics/index.js");
    await analytics.initAnalytics({ projectToken: "token", host: "" });
    const { logError } = await import("../src/evlog.js");

    logError("agent_work_failed", { installationId: 1 }, "raw string");
    logError("agent_work_failed", { installationId: 1, message: "fallback" });
    logError("agent_work_failed", { installationId: 1 });

    const calls = mockPostHog.instances[0]?.captureException.mock.calls ?? [];
    expect(calls[0]?.[0]).toEqual(expect.objectContaining({ message: "raw string" }));
    expect(calls[1]?.[0]).toEqual(expect.objectContaining({ message: "fallback" }));
    expect(calls[2]?.[0]).toEqual(expect.objectContaining({ message: "agent_work_failed" }));
  });

  it("strips analyticsDistinctId, error, and err from forwarded properties", async () => {
    const analytics = await import("../src/analytics/index.js");
    await analytics.initAnalytics({ projectToken: "token", host: "" });
    const { logError } = await import("../src/evlog.js");

    logError(
      "ev",
      { analyticsDistinctId: "x", error: "skip", err: "skip", kept: 1 },
      new Error("boom"),
    );

    const props = mockPostHog.instances[0]?.captureException.mock.calls[0]?.[2] as Record<
      string,
      unknown
    >;
    expect(props).toMatchObject({ event: "ev", kept: 1 });
    expect(props).not.toHaveProperty("analyticsDistinctId");
    expect(props).not.toHaveProperty("error");
    expect(props).not.toHaveProperty("err");
  });

  it("keeps analytics disabled when PostHog sink construction fails", async () => {
    mockPostHog.PostHog.mockImplementationOnce(() => {
      throw new Error("sdk missing");
    });
    const analytics = await import("../src/analytics/index.js");

    await expect(analytics.initAnalytics({ projectToken: "token", host: "" })).rejects.toThrow(
      /sdk missing/,
    );
    expect(analytics.isAnalyticsEnabled()).toBe(false);
    analytics.captureEvent({ distinctId: "server", event: "webhook received" });
    analytics.captureException(new Error("boom"), "server");
    expect(mockPostHog.instances).toHaveLength(0);
  });

  it("commits a replacement sink only after construction succeeds", async () => {
    const analytics = await import("../src/analytics/index.js");

    await analytics.initAnalytics({
      projectToken: "token-1",
      host: "https://a.example",
    });
    const previous = mockPostHog.instances[0];
    expect(analytics.isAnalyticsEnabled()).toBe(true);

    await analytics.initAnalytics({
      projectToken: "token-2",
      host: "https://b.example",
    });
    expect(analytics.isAnalyticsEnabled()).toBe(true);
    expect(mockPostHog.instances).toHaveLength(2);
    expect(mockPostHog.instances[1]?.apiKey).toBe("token-2");
    expect(mockPostHog.instances[1]?.options.host).toBe("https://b.example");

    analytics.captureEvent({ distinctId: "server", event: "webhook received" });
    analytics.captureException(new Error("boom"), "server");
    expect(previous?.capture).not.toHaveBeenCalled();
    expect(previous?.captureException).not.toHaveBeenCalled();
    expect(mockPostHog.instances[1]?.capture).toHaveBeenCalledTimes(1);
    expect(mockPostHog.instances[1]?.captureException).toHaveBeenCalledTimes(1);
  });

  it("restores no-op and disables after a failed reinitialization", async () => {
    const analytics = await import("../src/analytics/index.js");

    await analytics.initAnalytics({ projectToken: "token", host: "" });
    const previous = mockPostHog.instances[0];
    expect(analytics.isAnalyticsEnabled()).toBe(true);

    mockPostHog.PostHog.mockImplementationOnce(() => {
      throw new Error("reinit failed");
    });
    await expect(analytics.initAnalytics({ projectToken: "token-2", host: "" })).rejects.toThrow(
      /reinit failed/,
    );

    expect(analytics.isAnalyticsEnabled()).toBe(false);
    analytics.captureEvent({
      distinctId: "server",
      event: "webhook received",
      properties: { github_event: "ping" },
    });
    analytics.captureException(new Error("boom"), "server", { step: "test" });
    expect(previous?.capture).not.toHaveBeenCalled();
    expect(previous?.captureException).not.toHaveBeenCalled();
    expect(mockPostHog.instances).toHaveLength(1);
    await expect(analytics.shutdownAnalytics()).resolves.toBeUndefined();
  });

  it("disables and drops the previous sink when reinitialized with an empty token", async () => {
    const analytics = await import("../src/analytics/index.js");

    await analytics.initAnalytics({ projectToken: "token", host: "" });
    const previous = mockPostHog.instances[0];
    expect(analytics.isAnalyticsEnabled()).toBe(true);

    await analytics.initAnalytics({ projectToken: "  ", host: "" });
    expect(analytics.isAnalyticsEnabled()).toBe(false);
    analytics.captureEvent({ distinctId: "server", event: "webhook received" });
    analytics.captureException(new Error("boom"), "server");
    expect(previous?.capture).not.toHaveBeenCalled();
    expect(previous?.captureException).not.toHaveBeenCalled();
    expect(mockPostHog.PostHog).toHaveBeenCalledTimes(1);
  });

  it("does not register process signal listeners", async () => {
    const processOn = vi.spyOn(process, "on");

    await import("../src/analytics/index.js");

    expect(processOn).not.toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(processOn).not.toHaveBeenCalledWith("SIGTERM", expect.any(Function));
  });

  it("initNoOpAnalytics keeps capture paths no-op without constructing PostHog", async () => {
    const { captureEvent, initNoOpAnalytics, isAnalyticsEnabled } =
      await import("../src/analytics/index.js");
    initNoOpAnalytics();
    captureEvent({ distinctId: "server", event: "webhook received" });
    captureEvent({
      distinctId: "installation:1",
      event: "review profiled",
      properties: { outcome: "published", work_item_id: "wi-1" },
    });
    expect(isAnalyticsEnabled()).toBe(false);
    expect(mockPostHog.PostHog).not.toHaveBeenCalled();
  });

  it("shutdownAnalytics resolves when no client was initialised", async () => {
    const { shutdownAnalytics } = await import("../src/analytics/index.js");
    await expect(shutdownAnalytics()).resolves.toBeUndefined();
  });

  it("before_send leaves events without error fields unchanged", async () => {
    const { initAnalytics } = await import("../src/analytics/index.js");
    await initAnalytics({ projectToken: "token", host: "" });

    const beforeSend = mockPostHog.instances[0]?.options.before_send;
    const event = { distinctId: "x", event: "y" };
    expect(beforeSend?.(event)).toBe(event);
  });
});
