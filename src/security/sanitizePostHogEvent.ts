import { sanitizeTelemetryValue } from "./sanitizeTelemetryValue.ts";
import { isRecord } from "../util/typeGuards.ts";

function isPostHogEventMessage(value: unknown): value is PostHogEventMessage {
  return isRecord(value) && (value.properties == null || isRecord(value.properties));
}

export type PostHogEventMessage = {
  readonly properties?: Record<string | number, unknown> | null;
  readonly [key: string]: unknown;
};

export function sanitizePostHogEvent(event: PostHogEventMessage | null) {
  if (event == null) return ((pinnedReturn: PostHogEventMessage | null) => pinnedReturn)(null);
  const sanitized = sanitizeTelemetryValue(event);
  if (!isPostHogEventMessage(sanitized)) {
    return ((pinnedReturn: PostHogEventMessage | null) => pinnedReturn)({ properties: {} });
  }
  return ((pinnedReturn: PostHogEventMessage | null) => pinnedReturn)(sanitized);
}
