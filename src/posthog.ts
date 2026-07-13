import { PostHog } from "posthog-node";
import type { Config } from "./config.js";

export type PostHogConfigSlice = Pick<
  Config,
  "posthogProjectToken" | "posthogHost" | "posthogExceptionAutocapture"
>;

let client: PostHog | undefined;

export function createPostHogFromConfig(cfg: PostHogConfigSlice): PostHog {
  const host = cfg.posthogHost.trim();
  return new PostHog(cfg.posthogProjectToken, {
    ...(host ? { host } : {}),
    enableExceptionAutocapture: cfg.posthogExceptionAutocapture,
  });
}

export function initPostHog(cfg: PostHogConfigSlice): void {
  if (client !== undefined) {
    return;
  }
  client = createPostHogFromConfig(cfg);
}

function requireClient(): PostHog {
  if (client === undefined) {
    throw new Error("PostHog is not initialized; call initPostHog(cfg) after loadConfig()");
  }
  return client;
}

export const posthog = {
  capture: (...args: Parameters<PostHog["capture"]>) => requireClient().capture(...args),
  captureException: (...args: Parameters<PostHog["captureException"]>) =>
    requireClient().captureException(...args),
  shutdown: () => requireClient().shutdown(),
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
