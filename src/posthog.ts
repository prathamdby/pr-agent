import { PostHog } from "posthog-node";
import { sanitizePostHogEvent } from "./security/sanitizePostHogEvent.js";

let client: PostHog | null = null;

function buildClient(projectToken: string, host: string): PostHog {
  return new PostHog(projectToken, {
    ...(host ? { host } : {}),
    enableExceptionAutocapture: true,
    before_send: sanitizePostHogEvent,
  });
}

/** Called once from src/index.ts with loadConfig() values; an empty token disables capture. */
export function initPostHog(opts: { readonly projectToken: string; readonly host: string }): void {
  client ??= buildClient(opts.projectToken, opts.host.trim());
}

export function getPostHog(): PostHog {
  client ??= buildClient("", "");
  return client;
}

export function shutdownPostHog(): Promise<void> {
  return client ? Promise.resolve(client.shutdown()) : Promise.resolve();
}
