import { PostHog } from "posthog-node";
import { sanitizePostHogEvent } from "./security/sanitizePostHogEvent.js";

const apiKey = process.env.POSTHOG_PROJECT_TOKEN ?? "";
const host = process.env.POSTHOG_HOST;

export const posthog = new PostHog(apiKey, {
  ...(host ? { host } : {}),
  enableExceptionAutocapture: true,
  before_send: sanitizePostHogEvent,
});

export function shutdownPostHog(): Promise<void> {
  return Promise.resolve(posthog.shutdown());
}
