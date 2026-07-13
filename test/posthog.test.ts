import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { PostHogInitOptions } from "../src/posthog.js";

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

function initFromOptions(options: PostHogInitOptions) {
  return import("../src/posthog.js").then(({ initPostHog }) => {
    initPostHog(options);
  });
}

describe("posthog client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    mockPostHog.instances.length = 0;
    mockPostHog.PostHog.mockClear();
  });

  it("constructs the client from Config options with exception autocapture", async () => {
    await initFromOptions({
      enabled: true,
      projectToken: "token",
      host: "https://posthog.example",
      exceptionAutocapture: true,
    });

    expect(mockPostHog.PostHog).toHaveBeenCalledWith("token", {
      host: "https://posthog.example",
      enableExceptionAutocapture: true,
    });
  });

  it("constructs with an empty token when enabled (intentional no-op SDK client)", async () => {
    await initFromOptions({
      enabled: true,
      projectToken: "",
      host: "",
      exceptionAutocapture: true,
    });

    expect(mockPostHog.PostHog).toHaveBeenCalledWith("", {
      enableExceptionAutocapture: true,
    });
  });

  it("skips client construction when disabled", async () => {
    await initFromOptions({
      enabled: false,
      projectToken: "token",
      host: "https://posthog.example",
      exceptionAutocapture: true,
    });

    expect(mockPostHog.PostHog).not.toHaveBeenCalled();
  });

  it("honors exception autocapture=false from Config", async () => {
    await initFromOptions({
      enabled: true,
      projectToken: "token",
      host: "",
      exceptionAutocapture: false,
    });

    expect(mockPostHog.PostHog).toHaveBeenCalledWith("token", {
      enableExceptionAutocapture: false,
    });
  });

  it("does not register process signal listeners", async () => {
    const processOn = vi.spyOn(process, "on");

    await initFromOptions({
      enabled: true,
      projectToken: "token",
      host: "",
      exceptionAutocapture: true,
    });

    expect(processOn).not.toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(processOn).not.toHaveBeenCalledWith("SIGTERM", expect.any(Function));
  });

  it("shuts down the singleton client through the exported helper", async () => {
    const { initPostHog, shutdownPostHog } = await import("../src/posthog.js");
    initPostHog({
      enabled: true,
      projectToken: "token",
      host: "",
      exceptionAutocapture: true,
    });

    await shutdownPostHog();

    expect(mockPostHog.instances[0]?.shutdown).toHaveBeenCalledTimes(1);
  });

  it("shutdown is a no-op when analytics is disabled", async () => {
    const { initPostHog, shutdownPostHog } = await import("../src/posthog.js");
    initPostHog({
      enabled: false,
      projectToken: "",
      host: "",
      exceptionAutocapture: true,
    });

    await expect(shutdownPostHog()).resolves.toBeUndefined();
    expect(mockPostHog.PostHog).not.toHaveBeenCalled();
  });
});
