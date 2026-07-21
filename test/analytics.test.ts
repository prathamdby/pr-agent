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
    const token = "ghp_1234567890123456789012345678901234";
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
    expect(client?.captureException).toHaveBeenCalledWith(err, "installation:1", {
      type: "review",
    });
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
    expect(call?.[0]).toBe(err);
    expect(call?.[1]).toBe("installation:42");
    expect(call?.[2]).toMatchObject({
      event: "agent_work_failed",
      errorCode: "agent_work.failed",
      errorContext: { workItemId: "w1" },
    });
  });

  it("does not forward logError when analytics is disabled", async () => {
    const analytics = await import("../src/analytics/index.js");
    await analytics.initAnalytics({ projectToken: "", host: "" });

    const { logError } = await import("../src/evlog.js");
    logError("agent_work_failed", { message: "boom", installationId: 1 });

    expect(mockPostHog.PostHog).not.toHaveBeenCalled();
  });
});
