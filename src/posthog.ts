import { PostHog } from "posthog-node";
import {
  DEFAULT_POSTHOG_HOST,
  DEFAULT_POSTHOG_PROJECT_TOKEN,
  ENV,
} from "./settings/index.js";
import { sanitizePostHogEvent } from "./security/sanitizePostHogEvent.js";

const apiKey = process.env[ENV.POSTHOG_PROJECT_TOKEN] ?? DEFAULT_POSTHOG_PROJECT_TOKEN;
const host = (process.env[ENV.POSTHOG_HOST] ?? DEFAULT_POSTHOG_HOST).trim();

export const posthog = new PostHog(apiKey, {
  ...(host ? { host } : {}),
  enableExceptionAutocapture: true,
  before_send: sanitizePostHogEvent,
});

export function shutdownPostHog(): Promise<void> {
  return Promise.resolve(posthog.shutdown());
}
