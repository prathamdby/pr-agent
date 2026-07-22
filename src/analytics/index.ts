import { noopAnalyticsSink } from "./noop.js";
import type { AnalyticsSink, CaptureEventInput } from "./types.js";

let sink: AnalyticsSink = noopAnalyticsSink;
let enabled = false;

export async function initAnalytics(opts: {
  readonly projectToken: string;
  readonly host: string;
}): Promise<void> {
  const projectToken = opts.projectToken.trim();
  if (!projectToken) {
    sink = noopAnalyticsSink;
    enabled = false;
    return;
  }

  const { createPostHogSink } = await import("./posthogSink.js");
  sink = createPostHogSink({ projectToken, host: opts.host.trim() });
  enabled = true;
}

export function initNoOpAnalytics(): void {
  sink = noopAnalyticsSink;
  enabled = false;
}

export function isAnalyticsEnabled(): boolean {
  return enabled;
}

export function captureEvent(input: CaptureEventInput): void {
  sink.captureEvent(input);
}

export function captureException(
  error: unknown,
  distinctId: string,
  properties?: Record<string, unknown>,
): void {
  sink.captureException(error, distinctId, properties);
}

export function shutdownAnalytics(): Promise<void> {
  const current = sink;
  sink = noopAnalyticsSink;
  enabled = false;
  return current.shutdown();
}
