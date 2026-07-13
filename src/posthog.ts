import { PostHog } from "posthog-node";

export type PostHogInitOptions = {
  readonly enabled: boolean;
  readonly projectToken: string;
  readonly host: string;
  readonly exceptionAutocapture: boolean;
};

type PostHogClient = {
  capture: PostHog["capture"];
  captureException: PostHog["captureException"];
  shutdown: PostHog["shutdown"];
};

function createDisabledClient(): PostHogClient {
  return {
    capture() {},
    captureException() {},
    async shutdown() {},
  };
}

let client: PostHogClient = createDisabledClient();

/** Call once after `loadConfig()` before webhook/worker work. */
export function initPostHog(options: PostHogInitOptions): void {
  if (!options.enabled) {
    client = createDisabledClient();
    return;
  }

  const host = options.host.trim();
  client = new PostHog(options.projectToken, {
    ...(host ? { host } : {}),
    enableExceptionAutocapture: options.exceptionAutocapture,
  });
}

export const posthog: PostHogClient = {
  capture: (...args) => client.capture(...args),
  captureException: (...args) => client.captureException(...args),
  shutdown: (...args) => client.shutdown(...args),
};

export function shutdownPostHog(): Promise<void> {
  return Promise.resolve(posthog.shutdown());
}
