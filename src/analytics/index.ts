import type { JsonObject } from "../util/jsonValue.js";
import { noopAnalyticsSink } from "./noop.js";
import type { AnalyticsSink, CaptureEventInput } from "./types.js";

export { resetPostHogClientFactory, setPostHogClientFactory } from "./posthogSink.js";
export type { PostHogClient, PostHogClientFactory } from "./posthogSink.js";

let sink: AnalyticsSink = noopAnalyticsSink;
let enabled = false;

export function setAnalyticsSink(next: AnalyticsSink, nextEnabled = true): void {
  sink = next;
  enabled = nextEnabled;
}

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

export function captureException(error: Error, distinctId: string, properties?: JsonObject): void {
  sink.captureException(error, distinctId, properties);
}

export function shutdownAnalytics(): Promise<void> {
  const current = sink;
  sink = noopAnalyticsSink;
  enabled = false;
  return current.shutdown();
}
