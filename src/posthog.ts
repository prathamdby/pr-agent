import { PostHog } from "posthog-node";

const apiKey = process.env.POSTHOG_PROJECT_TOKEN ?? "";
const host = process.env.POSTHOG_HOST;

export const posthog = new PostHog(apiKey, {
  ...(host ? { host } : {}),
  enableExceptionAutocapture: true,
});

process.on("SIGINT", async () => {
  await posthog.shutdown();
});

process.on("SIGTERM", async () => {
  await posthog.shutdown();
});
