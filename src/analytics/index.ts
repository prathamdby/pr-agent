import { noopAnalyticsSink } from "./noop.js";
import type { AnalyticsSink, CaptureEventInput } from "./types.js";
import { errorAnalyticsFields, sanitizeErrorForTelemetry } from "../errors/appError.js";
import {
  sanitizeTelemetryRecord,
  sanitizeTelemetryString,
} from "../security/sanitizeTelemetryValue.js";

type AnalyticsState = {
  readonly sink: AnalyticsSink;
  readonly enabled: boolean;
};

const disabledState: AnalyticsState = {
  sink: noopAnalyticsSink,
  enabled: false,
};

let state: AnalyticsState = disabledState;

async function constructPostHogSink(projectToken: string, host: string): Promise<AnalyticsSink> {
  const { createPostHogSink } = await import("./posthogSink.js");
  return createPostHogSink({ projectToken, host });
}

export async function initAnalytics(opts: {
  readonly projectToken: string;
  readonly host: string;
}): Promise<void> {
  const projectToken = opts.projectToken.trim();
  if (!projectToken) {
    state = disabledState;
    return;
  }

  try {
    const nextSink = await constructPostHogSink(projectToken, opts.host.trim());
    state = { sink: nextSink, enabled: true };
  } catch (error) {
    // Failed reinitialization restores no-op + enabled false (audit policy).
    state = disabledState;
    throw error;
  }
}

export function initNoOpAnalytics(): void {
  state = disabledState;
}

export function isAnalyticsEnabled(): boolean {
  return state.enabled;
}

export function captureEvent(input: CaptureEventInput): void {
  state.sink.captureEvent({
    ...input,
    distinctId: sanitizeTelemetryString(input.distinctId),
    ...(input.properties !== undefined
      ? { properties: sanitizeTelemetryRecord(input.properties) ?? {} }
      : {}),
  });
}

export function captureException(
  error: unknown,
  distinctId: string,
  properties?: Record<string, unknown>,
): void {
  const safeProperties = sanitizeTelemetryRecord(properties);
  const safeErrorFields = errorAnalyticsFields(error);
  const forwardedProperties =
    safeProperties === undefined && Object.keys(safeErrorFields).length === 0
      ? undefined
      : { ...safeProperties, ...safeErrorFields };
  state.sink.captureException(
    sanitizeErrorForTelemetry(error),
    sanitizeTelemetryString(distinctId),
    forwardedProperties,
  );
}

export function shutdownAnalytics(): Promise<void> {
  const current = state.sink;
  state = disabledState;
  return current.shutdown();
}
