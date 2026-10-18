import { sanitizeTelemetryValue } from "./sanitizeTelemetryValue.ts";
import { isRecord } from "../util/typeGuards.ts";

function isPostHogEventMessage(value: unknown): value is PostHogEventMessage {
  return isRecord(value) && (value.properties == null || isRecord(value.properties));
}

export type PostHogEventMessage = {
  readonly properties?: Record<string | number, unknown> | null;
  readonly [key: string]: unknown;
};

export function sanitizePostHogEvent(
  event: PostHogEventMessage | null,
): PostHogEventMessage | null {
  if (event == null) return null;
  const sanitized = sanitizeTelemetryValue(event);
  if (!isPostHogEventMessage(sanitized)) {
    return { properties: {} };
  }
  return sanitized;
}
