import { PostHog } from "posthog-node";
import { sanitizePostHogEvent } from "../security/sanitizePostHogEvent.js";
import { ANALYTICS_SHUTDOWN_TIMEOUT_MS } from "../settings/index.js";
import type { AnalyticsSink } from "./types.js";

/** AI-lane client. No `before_send`: that sanitizer strips tool bodies. */
export type AiCapture = {
  capture(input: {
    readonly distinctId: string;
    readonly event: string;
    readonly properties: Record<string, unknown>;
  }): void;
  flush(): Promise<void>;
  shutdown(timeoutMs: number): Promise<void>;
};

export function createPostHogAiCapture(opts: {
  readonly projectToken: string;
  readonly host: string;
}): AiCapture {
  const client = new PostHog(opts.projectToken, {
    ...(opts.host ? { host: opts.host } : {}),
    flushInterval: 0,
    maxQueueSize: 1000,
    enableExceptionAutocapture: false,
    enableFullAiCapture: true,
  });
  return {
    capture(input) {
      client.captureAi({
        distinctId: input.distinctId,
        event: input.event,
        properties: input.properties,
      });
    },
    flush() {
      return client.flush();
    },
    shutdown(timeoutMs) {
      return client.shutdown(timeoutMs);
    },
  };
}

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
