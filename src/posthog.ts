import { PostHog } from "posthog-node";
import type { Config } from "./config.js";
import {
  DEFAULT_POSTHOG_EXCEPTION_AUTOCAPTURE,
  DEFAULT_POSTHOG_HOST,
  DEFAULT_POSTHOG_PROJECT_TOKEN,
} from "./settings/index.js";

export type PostHogConfigSlice = Pick<
  Config,
  "posthogProjectToken" | "posthogHost" | "posthogExceptionAutocapture"
>;

let client: PostHog | undefined;

function defaultConfigSlice(): PostHogConfigSlice {
  return {
    posthogProjectToken: DEFAULT_POSTHOG_PROJECT_TOKEN,
    posthogHost: DEFAULT_POSTHOG_HOST,
    posthogExceptionAutocapture: DEFAULT_POSTHOG_EXCEPTION_AUTOCAPTURE,
  };
}

export function createPostHogFromConfig(cfg: PostHogConfigSlice): PostHog {
  const host = cfg.posthogHost.trim();
  return new PostHog(cfg.posthogProjectToken, {
    ...(host ? { host } : {}),
    enableExceptionAutocapture: cfg.posthogExceptionAutocapture,
  });
}

export function initPostHog(cfg: PostHogConfigSlice): void {
  client = createPostHogFromConfig(cfg);
}

function getClient(): PostHog {
  if (client === undefined) {
    client = createPostHogFromConfig(defaultConfigSlice());
  }
  return client;
}

export const posthog = {
  capture: (...args: Parameters<PostHog["capture"]>) => getClient().capture(...args),
  captureException: (...args: Parameters<PostHog["captureException"]>) =>
    getClient().captureException(...args),
  shutdown: () => getClient().shutdown(),
};

export function shutdownPostHog(): Promise<void> {
  if (client === undefined) {
    return Promise.resolve();
  }
  return Promise.resolve(client.shutdown());
}

export function resetPostHogForTests(): void {
  client = undefined;
}
