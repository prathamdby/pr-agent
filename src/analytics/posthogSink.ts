import { PostHog, type EventMessage } from "posthog-node";
import { sanitizePostHogEvent } from "../security/sanitizePostHogEvent.js";
import type { AnalyticsSink } from "./types.js";

export function createPostHogSink(opts: {
  readonly projectToken: string;
  readonly host: string;
}): AnalyticsSink {
  const client = new PostHog(opts.projectToken, {
    ...(opts.host ? { host: opts.host } : {}),
    enableExceptionAutocapture: true,
    before_send: (event) => sanitizePostHogEvent(event) as EventMessage | null,
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
      return Promise.resolve(client.shutdown());
    },
  };
}
