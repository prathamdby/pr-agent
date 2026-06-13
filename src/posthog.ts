import { PostHog } from "posthog-node";

const apiKey = process.env.POSTHOG_PROJECT_TOKEN ?? "";
const host = process.env.POSTHOG_HOST;

export const posthog = new PostHog(apiKey, {
  ...(host ? { host } : {}),
  enableExceptionAutocapture: false,
});

export function shutdownPostHog(): Promise<void> {
  return Promise.resolve(posthog.shutdown());
}
