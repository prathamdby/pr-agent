import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { EventMessage } from "posthog-node";
import { ENV } from "../src/settings/index.js";
import { sanitizePostHogEvent } from "../src/security/sanitizePostHogEvent.js";

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
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    mockPostHog.instances.length = 0;
    delete process.env[ENV.POSTHOG_PROJECT_TOKEN];
    delete process.env[ENV.POSTHOG_HOST];
  });

  it("constructs the client with exception autocapture and before_send sanitizer", async () => {
    const { initPostHog } = await import("../src/posthog.js");

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
});
