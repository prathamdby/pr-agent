import { PostHog } from "posthog-node";
import { sanitizePostHogEvent } from "../security/sanitizePostHogEvent.js";
import { ANALYTICS_SHUTDOWN_TIMEOUT_MS } from "../settings/index.js";
import type { AnalyticsSink } from "./types.js";

export function createPostHogSink(opts: {
  readonly projectToken: string;
  readonly host: string;
}): AnalyticsSink {
  const client = new PostHog(opts.projectToken, {
    ...(opts.host ? { host: opts.host } : {}),
    enableExceptionAutocapture: true,
    before_send: (event) => {
      const sanitized = sanitizePostHogEvent(event);
      if (sanitized === event) return event;
      if (sanitized == null || typeof sanitized.event !== "string") return null;
      return {
        ...sanitized,
        event: sanitized.event,
        properties: sanitized.properties ?? undefined,
      };
    },
  });

  return {
    captureEvent(input) {
      client.capture({
        distinctId: input.distinctId,
        event: input.event,
        ...(input.properties !== undefined ? { properties: input.properties } : {}),
      });
    },
    captureException(error, distinctId, properties) {
      client.captureException(error, distinctId, properties);
    },
    shutdown() {
      return client.shutdown(ANALYTICS_SHUTDOWN_TIMEOUT_MS);
    },
  };
}
