import { sanitizeTelemetryValue } from "./sanitizeTelemetryValue.js";

/** Structural subset of posthog-node EventMessage used by before_send (no SDK import). */
export type PostHogEventMessage = {
  readonly properties?: Record<string | number, unknown> | null;
  readonly [key: string]: unknown;
};

export function sanitizePostHogEvent(
  event: PostHogEventMessage | null,
): PostHogEventMessage | null {
  if (event == null) return null;
  const sanitized = sanitizeTelemetryValue(event);
  if (typeof sanitized !== "object" || sanitized === null || Array.isArray(sanitized)) {
    return { properties: {} };
  }
  return sanitized as PostHogEventMessage;
}
