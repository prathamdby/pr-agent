import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

type PostHogOptions = {
  readonly host?: string;
  readonly enableExceptionAutocapture?: boolean;
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
      const shutdown = vi.fn(() => undefined);
      instances.push({ apiKey, options, shutdown });
      return { shutdown, capture: vi.fn(), captureException: vi.fn() };
    }),
  };
});

vi.mock("posthog-node", () => ({ PostHog: mockPostHog.PostHog }));

describe("posthog client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    mockPostHog.instances.length = 0;
    delete process.env.POSTHOG_PROJECT_TOKEN;
    delete process.env.POSTHOG_HOST;
  });

  it("constructs the client without process-wide exception autocapture", async () => {
    process.env.POSTHOG_PROJECT_TOKEN = "token";
    process.env.POSTHOG_HOST = "https://posthog.example";

    await import("../src/posthog.js");

    expect(mockPostHog.PostHog).toHaveBeenCalledWith("token", {
      host: "https://posthog.example",
      enableExceptionAutocapture: false,
    });
  });

  it("does not register process signal listeners", async () => {
    const processOn = vi.spyOn(process, "on");

    await import("../src/posthog.js");

    expect(processOn).not.toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(processOn).not.toHaveBeenCalledWith("SIGTERM", expect.any(Function));
  });

  it("shuts down the singleton client through the exported helper", async () => {
    const { shutdownPostHog } = await import("../src/posthog.js");

    await shutdownPostHog();

    expect(mockPostHog.instances[0]?.shutdown).toHaveBeenCalledTimes(1);
  });
});
