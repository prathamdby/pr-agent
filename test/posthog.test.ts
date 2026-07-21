import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { EventMessage } from "posthog-node";
import { ENV } from "../src/settings/index.js";

type PostHogOptions = {
  readonly host?: string;
  readonly enableExceptionAutocapture?: boolean;
  readonly before_send?: (event: EventMessage | null) => EventMessage | null;
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
  beforeEach(() => {
    // Drop the shared setupFiles no-op client so each case starts uninitialized.
    vi.resetModules();
    mockPostHog.instances.length = 0;
    mockPostHog.PostHog.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    mockPostHog.instances.length = 0;
    delete process.env[ENV.POSTHOG_PROJECT_TOKEN];
    delete process.env[ENV.POSTHOG_HOST];
  });

  it("constructs the client with exception autocapture and before_send sanitizer", async () => {
    const { initPostHog } = await import("../src/posthog.js");
    const { sanitizePostHogEvent } = await import("../src/security/sanitizePostHogEvent.js");

    initPostHog({ projectToken: "token", host: "https://posthog.example" });

    expect(mockPostHog.PostHog).toHaveBeenCalledWith("token", {
      host: "https://posthog.example",
      enableExceptionAutocapture: true,
      before_send: sanitizePostHogEvent,
    });
  });

  it("does not register process signal listeners", async () => {
    const processOn = vi.spyOn(process, "on");

    await import("../src/posthog.js");

    expect(processOn).not.toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(processOn).not.toHaveBeenCalledWith("SIGTERM", expect.any(Function));
  });

  it("shuts down the singleton client through the exported helper", async () => {
    const { initPostHog, shutdownPostHog } = await import("../src/posthog.js");

    initPostHog({ projectToken: "", host: "" });
    await shutdownPostHog();

    expect(mockPostHog.instances[0]?.shutdown).toHaveBeenCalledTimes(1);
  });

  it("throws from getPostHog when initPostHog was not called", async () => {
    const { AppError } = await import("../src/errors/appError.js");
    const { getPostHog } = await import("../src/posthog.js");
    try {
      getPostHog();
      expect.fail("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as InstanceType<typeof AppError>).code).toBe("posthog.not_initialized");
      expect((e as Error).message).toMatch(/not initialized/);
    }
  });

  it("initNoOpPostHog installs an empty-token client for tests", async () => {
    const { getPostHog, initNoOpPostHog } = await import("../src/posthog.js");
    initNoOpPostHog();
    expect(getPostHog()).toBeDefined();
    expect(mockPostHog.instances[0]?.apiKey).toBe("");
  });

  it("shutdownPostHog resolves when no client was initialised", async () => {
    const { shutdownPostHog } = await import("../src/posthog.js");
    await expect(shutdownPostHog()).resolves.toBeUndefined();
  });
});
