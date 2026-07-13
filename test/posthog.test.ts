import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { PostHogConfigSlice } from "../src/posthog.js";

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

function slice(partial: Partial<PostHogConfigSlice> = {}): PostHogConfigSlice {
  return {
    posthogProjectToken: "",
    posthogHost: "",
    posthogExceptionAutocapture: true,
    ...partial,
  };
}

describe("posthog client", () => {
  afterEach(async () => {
    const { resetPostHogForTests } = await import("../src/posthog.js");
    resetPostHogForTests();
    vi.restoreAllMocks();
    vi.resetModules();
    mockPostHog.instances.length = 0;
    mockPostHog.PostHog.mockClear();
  });

  it("constructs the client from Config with exception autocapture enabled", async () => {
    const { createPostHogFromConfig } = await import("../src/posthog.js");

    createPostHogFromConfig(
      slice({
        posthogProjectToken: "token",
        posthogHost: "https://posthog.example",
        posthogExceptionAutocapture: true,
      }),
    );

    expect(mockPostHog.PostHog).toHaveBeenCalledWith("token", {
      host: "https://posthog.example",
      enableExceptionAutocapture: true,
    });
  });

  it("omits host when Config host is empty and honors disabled autocapture", async () => {
    const { createPostHogFromConfig } = await import("../src/posthog.js");

    createPostHogFromConfig(
      slice({
        posthogProjectToken: "",
        posthogHost: "   ",
        posthogExceptionAutocapture: false,
      }),
    );

    expect(mockPostHog.PostHog).toHaveBeenCalledWith("", {
      enableExceptionAutocapture: false,
    });
  });

  it("initializes the singleton from Config and shuts it down through the helper", async () => {
    const { initPostHog, shutdownPostHog, posthog } = await import("../src/posthog.js");

    initPostHog(
      slice({
        posthogProjectToken: "token",
        posthogHost: "https://posthog.example",
      }),
    );

    posthog.capture({ distinctId: "server", event: "test" });
    await shutdownPostHog();

    expect(mockPostHog.instances).toHaveLength(1);
    expect(mockPostHog.instances[0]?.shutdown).toHaveBeenCalledTimes(1);
  });

  it("does not register process signal listeners", async () => {
    const processOn = vi.spyOn(process, "on");
    const { initPostHog } = await import("../src/posthog.js");

    initPostHog(slice({ posthogProjectToken: "token" }));

    expect(processOn).not.toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(processOn).not.toHaveBeenCalledWith("SIGTERM", expect.any(Function));
  });

  it("lazily constructs from settings defaults before init", async () => {
    const { posthog } = await import("../src/posthog.js");

    posthog.capture({ distinctId: "server", event: "pre-init" });

    expect(mockPostHog.PostHog).toHaveBeenCalledWith("", {
      enableExceptionAutocapture: true,
    });
  });

  it("shutdown is a no-op before any client exists", async () => {
    const { shutdownPostHog } = await import("../src/posthog.js");
    await expect(shutdownPostHog()).resolves.toBeUndefined();
    expect(mockPostHog.PostHog).not.toHaveBeenCalled();
  });
});
