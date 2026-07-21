import { captureEvent, captureException } from "../../../analytics/index.js";

const WORKER_DISTINCT_ID = "worker";

export function captureCursorWorkerEvent(
  event: string,
  properties?: Record<string, unknown>,
): void {
  captureEvent({
    distinctId: WORKER_DISTINCT_ID,
    event,
    properties: { provider: "cursor", ...properties },
  });
}

export function captureCursorWorkerFailure(
  step: string,
  error: unknown,
  properties?: Record<string, unknown>,
): void {
  const errorObj = error instanceof Error ? error : new Error(String(error));
  captureCursorWorkerEvent("cursor worker failed", {
    step,
    error_message: errorObj.message,
    ...properties,
  });
  captureException(errorObj, WORKER_DISTINCT_ID, {
    type: "cursor",
    step,
    ...properties,
  });
}
