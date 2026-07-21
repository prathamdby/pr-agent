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
  }> = [];

  return {
    instances,
    PostHog: vi.fn(function MockPostHog(apiKey: string, options: PostHogOptions) {
      const shutdown = vi.fn(async () => undefined);
      instances.push({ apiKey, options, shutdown });
      return { shutdown, capture: vi.fn(), captureException: vi.fn() };
    }),
  };
});

vi.mock("posthog-node", () => ({ PostHog: mockPostHog.PostHog }));

describe("analytics PostHog sink", () => {
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

  it("constructs the client with exception autocapture and before_send sanitizer", async () => {
    const { initAnalytics } = await import("../src/analytics/index.js");

    await initAnalytics({ projectToken: "token", host: "https://posthog.example" });

    expect(mockPostHog.PostHog).toHaveBeenCalledWith("token", {
      host: "https://posthog.example",
      enableExceptionAutocapture: true,
      before_send: expect.any(Function),
    });
  });

  it("does not register process signal listeners", async () => {
    const processOn = vi.spyOn(process, "on");

    await import("../src/analytics/index.js");

    expect(processOn).not.toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(processOn).not.toHaveBeenCalledWith("SIGTERM", expect.any(Function));
  });

  it("shuts down the singleton client through the exported helper", async () => {
    const { initAnalytics, shutdownAnalytics } = await import("../src/analytics/index.js");

    await initAnalytics({ projectToken: "token", host: "" });
    await shutdownAnalytics();

    expect(mockPostHog.instances[0]?.shutdown).toHaveBeenCalledTimes(1);
  });

  it("initNoOpAnalytics keeps capture paths no-op without constructing PostHog", async () => {
    const { captureEvent, initNoOpAnalytics, isAnalyticsEnabled } =
      await import("../src/analytics/index.js");
    initNoOpAnalytics();
    captureEvent({ distinctId: "server", event: "webhook received" });
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
